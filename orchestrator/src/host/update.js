import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isNewer } from '../../core/shared/version.js'

const RELEASE_URL = 'https://api.github.com/repos/waikoeng234/Nodo/releases/latest'
const CACHE_MS = 6 * 60 * 60 * 1000
const RETRY_MS = 30 * 60 * 1000
const TIMEOUT_MS = 10_000

async function releaseResult(fetchImpl, current, source) {
  let release
  try {
    const response = await fetchImpl(RELEASE_URL, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!response.ok) return { value: null, ttl: RETRY_MS }
    release = await response.json()
  } catch { return { value: null, ttl: RETRY_MS } }
  const value = isNewer(current, release?.tag_name) ? {
    current, latest: release.tag_name.replace(/^v/i, ''), publishedAt: release.published_at ?? null,
    notes: typeof release.body === 'string' ? release.body : '',
    url: typeof release.html_url === 'string' && release.html_url.startsWith('https://github.com/') ? release.html_url : '', source,
  } : null
  return { value, ttl: CACHE_MS }
}

export async function checkRelease(fetchImpl, current, source) {
  return (await releaseResult(fetchImpl, current, source)).value
}

export function install(rt) {
  const pluginDir = fileURLToPath(new URL('../..', import.meta.url))
  const current = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version
  const source = existsSync(join(pluginDir, '..', '.git'))
  let cache = null, expiresAt = 0, checking = null
  const updateInfo = async () => {
    if (Date.now() < expiresAt) return cache
    checking ??= releaseResult(globalThis.fetch, current, source).then(({ value, ttl }) => {
      cache = value; expiresAt = Date.now() + ttl
      return value
    }).finally(() => { checking = null })
    return checking
  }
  const answer = rt.handle
  rt.handle = (endpoint, payload) => endpoint === 'update-info'
    ? updateInfo().then(value => ({ ok: true, value }))
    : answer(endpoint, payload)
}
