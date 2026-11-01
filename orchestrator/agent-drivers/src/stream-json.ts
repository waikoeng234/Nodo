// The stream-json transport shared by the claude and qoder CLIs: typed JSONL
// frames over stdio, not JSON-RPC. The CLI emits system/assistant/user/result
// frames and control_requests; the host side writes user frames,
// control_requests and control_responses.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { launchCommand } from './cli.js'

export type StreamJsonOptions<Frame = unknown, Request = unknown> = {
  name: string; executable: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv
  onFrame?: (frame: Frame) => void; onRequest?: (frame: Request) => void; onClose?: (error: Error) => void
}
export type StreamJsonConnection = { write(frame: unknown): void; running: Promise<void>; dispose(): void }

export function connectStreamJson<Frame = unknown, Request = unknown>({ name, executable, args, cwd, env, onFrame = () => {}, onRequest = () => {}, onClose = () => {} }: StreamJsonOptions<Frame, Request>): StreamJsonConnection {
  const launch = launchCommand(executable, args ?? [])
  const child = spawn(launch.bin, launch.args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}) })
  let closed = false
  let stderrTail = ''
  const write = (frame: unknown) => {
    if (closed || child.stdin.destroyed) throw new Error(`${name} CLI connection is closed`)
    child.stdin.write(`${JSON.stringify(frame)}\n`)
  }
  const finish = (error: Error) => {
    if (closed) return
    closed = true
    onClose(error)
    if (child.exitCode === null) child.kill('SIGTERM')
  }
  child.on('error', error => finish(new Error(`Cannot start ${name} CLI (${(error as NodeJS.ErrnoException).code ?? 'spawn failed'})`)))
  child.stdin.on('error', () => finish(new Error(`Cannot write to ${name} CLI`)))
  // stderr can carry configuration diagnostics; keep a short, secret-filtered tail.
  child.stderr.on('data', chunk => { stderrTail = `${stderrTail}${chunk}`.slice(-1024) })
  child.on('close', (code, signal) => {
    const hint = stderrTail.split('\n').filter(line => !/(api[-_]?key|token|secret|cookie|authorization)/i.test(line)).join(' ').slice(-300).trim()
    finish(new Error(`${name} CLI exited (${code ?? signal})${hint ? `: ${hint}` : ''}`))
  })
  // The CLI emits its session init only after the first user frame, so "the
  // process is up" is all a boot can wait for; the session id arrives later.
  const running = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
    child.once('close', () => reject(new Error(`${name} CLI exited during startup`)))
  })
  createInterface({ input: child.stdout }).on('line', line => {
    if (closed) return
    let frame: unknown
    try { frame = JSON.parse(line) } catch { return }
    try {
      if ((frame as { type: string }).type === 'control_request') onRequest(frame as Request)
      else onFrame(frame as Frame)
    } catch { finish(new Error(`Invalid ${name} protocol event`)) }
  })
  return {
    write,
    running,
    dispose() {
      if (closed) return
      closed = true
      child.stdin.end()
      if (child.exitCode === null) child.kill('SIGTERM')
    },
  }
}
