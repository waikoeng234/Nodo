import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const read = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return {}; throw error }
}
const entries = object => Object.entries(object ?? {}).map(([name, value]) => ({ name, value }))

// session mcpServers replaces configured servers; never discard an option the
// protocol cannot carry, or bypass project-specific cwd and trust handling.
export function zcodeMcpServers({ cwd, env = {} }) {
  try {
    for (let path = resolve(cwd); ; path = dirname(path)) {
      for (const file of ['zcode.json', '.zcode/config.json']) if (Object.keys(read(join(path, file)).mcp?.servers ?? {}).length) return
      if (path === dirname(path)) break
    }
    const config = read(join(env.HOME ?? process.env.HOME ?? homedir(), '.zcode/cli/config.json'))
    if (config.features?.mcp === false || Object.hasOwn(config.mcp?.servers ?? {}, 'nodo_role')) return
    const servers = []
    for (const [name, server] of Object.entries(config.mcp?.servers ?? {})) {
      if (server.enabled === false) continue
      const stdio = server.type === 'stdio' || (!server.type && server.command)
      const fields = stdio ? ['type', 'command', 'args', 'env', 'enabled', 'timeoutMs', 'protocolVersion'] : ['type', 'url', 'headers', 'oauth', 'enabled', 'timeoutMs', 'protocolVersion']
      if (Object.keys(server).some(key => !fields.includes(key)) || (!stdio && !['http', 'sse'].includes(server.type))) return
      const common = { name, ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}), ...(server.protocolVersion ? { protocolVersion: server.protocolVersion } : {}) }
      servers.push(stdio ? { ...common, command: server.command, args: server.args ?? [], env: entries(server.env) }
        : { ...common, type: server.type, url: server.url, headers: entries(server.headers), ...(server.oauth ? { oauth: server.oauth } : {}) })
    }
    return servers
  } catch { return undefined }
}
