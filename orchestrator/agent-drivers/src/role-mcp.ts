import { fileURLToPath } from 'node:url'

export type RoleMcpServer = { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
export type RoleMcpOptions = { toolIdentity?: boolean; readyFile?: string }

export function roleMcp(instructions?: string, identityFile?: string, { toolIdentity = false, readyFile }: RoleMcpOptions = {}): RoleMcpServer[] {
  if (!instructions) return []
  return [{
    name: 'nodo_role', command: process.execPath,
    args: [fileURLToPath(new URL('./role-server.js', import.meta.url))],
    // The plugin host may be an Electron binary (DeepSeek Harness), which
    // only runs the service script as node under this flag; plain node ignores it.
    env: [{ name: identityFile ? 'NODO_ROLE_FILE' : 'NODO_ROLE_INSTRUCTIONS', value: identityFile ?? instructions }, { name: 'ELECTRON_RUN_AS_NODE', value: '1' }, ...(toolIdentity ? [{ name: 'NODO_ROLE_TOOL_IDENTITY', value: '1' }] : []), ...(toolIdentity && readyFile ? [{ name: 'NODO_ROLE_READY_FILE', value: readyFile }] : [])],
  }]
}
