import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'

export interface HostWebSocket {
  readonly readyState: number
  send(data: string): void
  once(event: 'open', listener: () => void): unknown
  on(event: 'message', listener: (body: { toString(): string }) => void): unknown
  on(event: 'error' | 'close', listener: () => void): unknown
  terminate(): void
}

export interface HostWebSocketConstructor {
  new(url: string, options: { createConnection: () => Duplex }): HostWebSocket
  readonly OPEN: number
}

export function hostWebSocket(): HostWebSocketConstructor {
  const anchors = [import.meta.url, join(process.cwd(), 'package.json'), join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles/package.json')]
  for (const anchor of anchors) {
    try { return createRequire(anchor)('ws') as HostWebSocketConstructor } catch {}
  }
  throw new Error('The host must provide the ws WebSocket library for Codex shared-runtime connections')
}
