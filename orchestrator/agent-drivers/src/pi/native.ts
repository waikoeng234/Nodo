// pi RPC transport: a long-lived `pi --mode rpc` subprocess speaking strict JSONL
// on stdin (commands) and stdout (responses, session events, extension UI).
// Records split on LF only — U+2028/U+2029 are valid inside JSON strings, so the
// engine's own docs forbid line readers like readline.
import { spawn } from 'node:child_process'
import { launchCommand } from '../cli.js'
import type { PermissionMode } from '../spi.js'

export type PiArgsOptions = { model?: string; thinking?: string; instructions?: string; driverSessionId?: string; permission?: PermissionMode }
export type PiConnectOptions<Frame = unknown> = {
  executable: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv
  onFrame?: (record: Frame) => void; onClose?: (error: Error) => void
}
export type PiConnection = { write(record: unknown): void; running: Promise<void>; dispose(): void }

// RPC mode cannot show the project-trust prompt, and the host never silently
// trusts a workspace's .pi resources: project settings and extensions stay off.
// AGENTS.md/CLAUDE.md context files load regardless of this flag.
//
// pi has no native tier channel, so plan is enforced at launch: a read-only
// tool allowlist. The allowlist alone keeps MCP tools registered (pi only
// filters them when an entry starts with mcp__), so MCP support is cut
// outright — no servers connect. Absent or unknown permission reads as plan.
export function piArgs({ model, thinking, instructions, driverSessionId, permission }: PiArgsOptions = {}) {
  return [
    '--mode', 'rpc', '--no-approve',
    ...(permission === 'full' ? [] : ['--no-mcp', '--tools', 'read,grep,find,ls']),
    ...(model ? ['--model', model] : []),
    ...(thinking ? ['--thinking', thinking] : []),
    ...(instructions ? ['--append-system-prompt', instructions] : []),
    ...(driverSessionId ? ['--session-id', driverSessionId] : []),
  ]
}

export function connectPi<Frame = unknown>({ executable, args, cwd, env, onFrame = () => {}, onClose = () => {} }: PiConnectOptions<Frame>): PiConnection {
  const launch = launchCommand(executable, args ?? [])
  const child = spawn(launch.bin, launch.args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}) })
  let closed = false
  let stderrTail = ''
  let buffer = ''
  const write = (record: unknown) => {
    if (closed || child.stdin.destroyed) throw new Error('pi RPC connection is closed')
    child.stdin.write(`${JSON.stringify(record)}\n`)
  }
  const finish = (error: Error) => {
    if (closed) return
    closed = true
    onClose(error)
    if (child.exitCode === null) child.kill('SIGTERM')
  }
  child.on('error', error => finish(new Error(`Cannot start pi (${(error as NodeJS.ErrnoException).code ?? 'spawn failed'})`)))
  child.stdin.on('error', () => finish(new Error('Cannot write to pi')))
  // stderr can carry configuration diagnostics; keep a short, secret-filtered tail.
  child.stderr.on('data', chunk => { stderrTail = `${stderrTail}${chunk}`.slice(-1024) })
  child.on('close', (code, signal) => {
    const hint = stderrTail.split('\n').filter(line => !/(api[-_]?key|token|secret|cookie|authorization)/i.test(line)).join(' ').slice(-300).trim()
    finish(new Error(`pi exited (${code ?? signal})${hint ? `: ${hint}` : ''}`))
  })
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8')
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (closed) return
      let record: unknown
      try { record = JSON.parse(line) } catch { continue }
      try { onFrame(record as Frame) } catch { finish(new Error('Invalid pi protocol record')) }
    }
  })
  // Closing stdin is the engine's orderly shutdown path; it disposes the active
  // runtime and exits after the current command or settled run.
  const running = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
    child.once('close', () => reject(new Error('pi exited during startup')))
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
