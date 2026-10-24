import { fileURLToPath } from 'node:url'

export type RoleMcpServer = { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
export type RoleMcpOptions = { toolIdentity?: boolean; readyFile?: string }

export function roleMcp(instructions?: string, identityFile?: string, { toolIdentity = false, readyFile }: RoleMcpOptions = {}): RoleMcpServer[] {
  if (!instructions) return []
  return [{
    name: 'nodo_role', command: process.execPath,
    args: [fileURLToPath(new URL('./role-server.js', import.meta.url))],
    env: [{ name: identityFile ? 'NODO_ROLE_FILE' : 'NODO_ROLE_INSTRUCTIONS', value: identityFile ?? instructions }, ...(toolIdentity ? [{ name: 'NODO_ROLE_TOOL_IDENTITY', value: '1' }] : []), ...(toolIdentity && readyFile ? [{ name: 'NODO_ROLE_READY_FILE', value: readyFile }] : [])],
  }]
}
