import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function hostWebSocket() {
  const anchors = [import.meta.url, join(process.cwd(), 'package.json'), join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles/package.json')]
  for (const anchor of anchors) {
    try { return createRequire(anchor)('ws') } catch {}
  }
  throw new Error('The host must provide the ws WebSocket library for Codex shared-runtime connections')
}
