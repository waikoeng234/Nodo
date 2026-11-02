import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntime } from '../../index.js'
import { registerEchoEngine } from './echo-driver.js'

// Engine fixtures that proxy WebSocket framing over stdio need the ws library;
// point them at the host's own modules where no DSH home provides one.
process.env.CODEX_FIXTURE_WS ??= fileURLToPath(new URL('../../package.json', import.meta.url))

export const until = async (check, timeout = 8000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('condition not met in time')
}

export function boot(home, nativeHost = {}) {
  const disposers = []
  const routes = []
  registerEchoEngine()
  const runtime = createRuntime({ ...nativeHost, logger: nativeHost.logger ?? { warn() {} }, effect(factory) { const dispose = factory(); if (typeof dispose === 'function') disposers.push(dispose) }, connection: { fetch: { register(route) { routes.push(route); return () => {} } } } }, { home })
  const post = async (endpoint, payload) => (await routes[0].fetch(new Request('http://test/api/nodo', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const api = async (endpoint, payload) => {
    const result = await post(endpoint, payload)
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value
  }
  return { home, api, post, runtime, routes, dispose() { return Promise.all(disposers.splice(0).reverse().map(dispose => dispose())) } }
}

export async function withHost(run, nativeHost = {}) {
  const home = mkdtempSync(join(tmpdir(), 'orch-config-test-'))
  const host = boot(home, nativeHost)
  try { await run(host) }
  finally { await host.dispose(); rmSync(home, { recursive: true, force: true }) }
}
