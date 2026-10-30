import { fileURLToPath } from 'node:url'
import type { RoleMcpServer } from './role-mcp.js'

export const LEAD_TOOLS = ['nodo_board', 'nodo_delegate', 'nodo_interrupt']

export function leadMcp(socket: string, token: string, tokenFile?: string): RoleMcpServer[] {
  return [{ name: 'nodo_lead', command: process.execPath,
    args: [fileURLToPath(new URL('./lead-server.js', import.meta.url))],
    env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }, { name: 'NODO_LEAD_SOCKET', value: socket }, { name: tokenFile ? 'NODO_LEAD_TOKEN_FILE' : 'NODO_LEAD_TOKEN', value: tokenFile ?? token }],
  }]
}
