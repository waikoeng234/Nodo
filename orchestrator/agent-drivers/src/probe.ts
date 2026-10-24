// Whether this host can spawn child processes at all. A plugin host (dsh Desktop,
// a sandboxed web host, a container) may forbid or break child_process; every real
// driver needs it, so the orchestrator runs this once at install and shows the
// result, instead of failing later inside a user's first dispatch.
import { spawn } from 'node:child_process'

export type ProbeSpawnOptions = { bin?: string; args?: readonly string[]; timeoutMs?: number }
export type ProbeSpawnResult = { ok: true } | { ok: false; step: 'spawn' | 'timeout' | 'error' | 'exit'; error: string }

export function probeSpawn({ bin = process.execPath, args = ['-e', 'process.stdout.write("ok")'], timeoutMs = 10_000 }: ProbeSpawnOptions = {}): Promise<ProbeSpawnResult> {
  return new Promise((resolve) => {
    let settled = false
    let out = ''
    const finish = (result: ProbeSpawnResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    let child
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      return finish({ ok: false, step: 'spawn', error: String((error as { message?: unknown } | null | undefined)?.message ?? error) })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, step: 'timeout', error: `no exit within ${timeoutMs}ms` })
    }, timeoutMs)
    child.stdout?.on('data', chunk => { out += chunk })
    child.on('error', error => finish({ ok: false, step: 'error', error: String(error?.message ?? error) }))
    child.on('close', (code, signal) => {
      if (code === 0 && out.includes('ok')) return finish({ ok: true })
      finish({ ok: false, step: 'exit', error: `exit ${code}${signal ? ` by ${signal}` : ''}: ${out.slice(0, 200)}` })
    })
  })
}
