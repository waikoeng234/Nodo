import { fileURLToPath } from 'node:url'
import type { RoleMcpServer } from './role-mcp.js'

export function leadMcp(socket: string, token: string): RoleMcpServer[] {
  return [{ name: 'nodo_lead', command: process.execPath,
    args: [fileURLToPath(new URL('./lead-server.js', import.meta.url))],
    env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }, { name: 'NODO_LEAD_SOCKET', value: socket }, { name: 'NODO_LEAD_TOKEN', value: token }],
  }]
}
