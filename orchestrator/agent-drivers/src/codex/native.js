import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { jsonRpcProcess } from '../json-rpc-process.js'
import { hostWebSocket } from '../websocket.js'

const execute = promisify(execFile)

export async function connectCodex({ executable, cwd, env, socket, start = true, ...callbacks }) {
  // The questions capability rides the engine's request_user_input tool, gated
  // behind its default_mode_request_user_input feature; the override only lands
  // when this call actually starts the daemon, and an existing shared daemon
  // keeps whatever config it was started with.
  if (start && !socket) await execute(executable, ['app-server', 'daemon', 'start', '-c', 'features.default_mode_request_user_input=true'], { env: { ...process.env, ...env }, timeout: 15000, maxBuffer: 16384 }).catch(() => { throw new Error('Cannot start the shared Codex runtime. Verify codex app-server daemon start in your terminal.') })
  return jsonRpcProcess({ bin: executable, args: ['app-server', 'proxy', ...(socket ? ['--sock', socket] : [])], cwd, env, WebSocket: hostWebSocket(), ...callbacks })
}

export async function ensureCodexWorkspace(peer, { cwd, name, workspaceId }) {
  let cursor
  do {
    const page = await peer.request('project/list', { limit: 100, ...(cursor ? { cursor } : {}) })
    const existing = page.data.find(project => (project.id === workspaceId || project.roots.some(root => root.path === cwd)))
    if (existing) return existing.id
    cursor = page.nextCursor
  } while (cursor)
  // Keep the existing key namespace to reuse projects created before the rename.
  const idempotencyKey = createHash('sha256').update(`orchestrator:${cwd}`).digest('hex')
  return (await peer.request('project/create', { idempotencyKey, name: name ?? cwd.split('/').at(-1), roots: [{ path: cwd }] })).project.id
}
