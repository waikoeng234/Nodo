import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../../index.js'
import { registerEchoEngine } from './echo-driver.js'

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
  const runtime = createRuntime({ ...nativeHost, logger: { warn() {} }, effect(factory) { const dispose = factory(); if (typeof dispose === 'function') disposers.push(dispose) }, connection: { fetch: { register(route) { routes.push(route); return () => {} } } } }, { home })
  const post = async (endpoint, payload) => (await routes[0].fetch(new Request('http://test/api/nodo', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const api = async (endpoint, payload) => {
    const result = await post(endpoint, payload)
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value
  }
  return { home, api, post, runtime, routes, dispose() { for (const dispose of disposers.reverse()) dispose() } }
}

export async function withHost(run, nativeHost = {}) {
  const home = mkdtempSync(join(tmpdir(), 'orch-config-test-'))
  const host = boot(home, nativeHost)
  try { await run(host) }
  finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
}
