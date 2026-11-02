import { fileURLToPath } from 'node:url'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { loadMcpSdk } from './role-mcp.js'
import type { RoleMcpServer } from './role-mcp.js'

export const LEAD_TOOLS = ['nodo_board', 'nodo_delegate', 'nodo_interrupt']

export function leadMcp(socket: string, token: string, tokenFile?: string): RoleMcpServer[] {
  return [{ name: 'nodo_lead', command: process.execPath,
    args: [fileURLToPath(new URL('./lead-server.js', import.meta.url))],
    env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }, { name: 'NODO_LEAD_SOCKET', value: socket }, { name: tokenFile ? 'NODO_LEAD_TOKEN_FILE' : 'NODO_LEAD_TOKEN', value: tokenFile ?? token }],
  }]
}

const tools: Tool[] = [
  { name: 'nodo_board', description: '用于选择角色和查看历史。不要反复查表等待执行结束，结果会自动送来。默认只返回派活表。',
    inputSchema: { type: 'object', properties: { table: { type: 'string', enum: ['roles', 'delegations'] }, session: { type: 'string' } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'nodo_delegate', description: '受理任务或修改当前任务，本轮正常结束后发送。告诉用户已派给谁，然后结束本轮，结果会自动送来。本轮停止或出错则取消。',
    inputSchema: { type: 'object', required: ['type', 'hard', 'task'], additionalProperties: false, properties: {
      type: { type: 'string', description: '任务类型 id' },
      hard: { type: 'boolean', description: '派活前按本次剩余工作所需的推理深度判断：可直接应用已有方法或先例、主要工作是执行调整和验证时为 false；必要信息已掌握，但已有方法不能直接解决，仍需深入推导或作出影响结果的关键判断时为 true。选 true 时简要说明具体哪个问题需要更深的推理。工作量、文件数和风险不单独决定难度；需求和步骤明确也不代表关键步骤容易完成。关键事实不明时先派 investigate，调查按自身工作判断难度。' },
      task: { type: 'string', description: '执行者看不到你和用户的对话。只写以下内容，不适用的省略：1. 任务目标；2. 用户的决定和偏好、已确认的事实、已排除的做法；3. 本任务特有的范围和限制；4. 完成标准；5. 报告里需要额外交代的内容。用户本条消息的附件由 Nodo 自动附上；更早的附件需要时写明路径。结论写在执行者最后的回复里，不要写报告文件；改文件的工作只派给会改文件的任务类型。' },
      session: { type: 'string', description: '同一目标返工、或改正在执行的任务，且执行角色和难度不变时填；难度或角色变化、新目标、需要独立审查、原路径已证伪时不填，新开会话并应用本次模型设置，交代已有改动、报告和剩余问题。' },
    } } },
  { name: 'nodo_interrupt', description: '只停止本主控当前执行中的派活，等待确认结束后返回。要改需求用 nodo_delegate 带当前会话；用户只是问进度时不要停止。',
    inputSchema: { type: 'object', required: ['session'], properties: { session: { type: 'string' } }, additionalProperties: false } },
]

export async function leadServer(call: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>): Promise<Server> {
  const { Server, CallToolRequestSchema, ListToolsRequestSchema } = await loadMcpSdk()
  const server = new Server({ name: 'nodo-lead', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => call(params.name, params.arguments ?? {}))
  return server
}
