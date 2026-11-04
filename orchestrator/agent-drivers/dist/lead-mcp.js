import { fileURLToPath } from 'node:url';
import { loadMcpSdk } from './role-mcp.js';
export const LEAD_TOOLS = ['nodo_board', 'nodo_delegate', 'nodo_interrupt', 'nodo_task'];
export function leadMcp(socket, token, tokenFile) {
    return [{ name: 'nodo_lead', command: process.execPath,
            args: [fileURLToPath(new URL('./lead-server.js', import.meta.url))],
            env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }, { name: 'NODO_LEAD_SOCKET', value: socket }, { name: tokenFile ? 'NODO_LEAD_TOKEN_FILE' : 'NODO_LEAD_TOKEN', value: tokenFile ?? token }],
        }];
}
const tools = [
    { name: 'nodo_board', description: '选择角色和查看历史，默认返回派活表。table=tasks 列出本主控未结束、待送报告及最近 10 项任务摘要，taskId 返回单个任务的说明、执行详情和报告引用。不要反复查表等待执行结束，结果会自动送来。',
        inputSchema: { type: 'object', properties: { table: { type: 'string', enum: ['roles', 'delegations', 'tasks'] }, session: { type: 'string' }, taskId: { type: 'string' } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: 'nodo_delegate', description: '受理新任务或同任务后续执行，返回 taskId、executionId、session、role 和 queued 状态，本轮正常结束后发送。告诉用户已受理并结束本轮，结果会自动送来。本轮停止或出错则取消。多个任务会改同一批文件、需要隔离时用 worktree；有先后顺序要求用 dependsOn，依赖未验收时拒绝派活。执行者所需上下文要写全。Nodo 不会自动合并。执行结束后核对报告，用 nodo_task 验收。',
        inputSchema: { type: 'object', required: ['type', 'hard', 'task'], additionalProperties: false, properties: {
                type: { type: 'string', description: '任务类型 id' },
                taskId: { type: 'string', description: '继续已有任务时填写。省略则新建任务，标题从 task 自动提炼。' },
                parentId: { type: 'string', description: '本主控的父任务 id。带 taskId 时不可传，修改关系用 nodo_task revise。' },
                dependsOn: { type: 'array', items: { type: 'string', minLength: 1 }, description: '本主控的前置任务 id，须全部 done。带 taskId 时不可传。' },
                worktree: { type: 'boolean', description: 'true 为新任务创建独立 Git worktree，基于主控工作区 HEAD，不含未提交改动和依赖。带 taskId 时沿用原执行目录，不能切换；带 session 续用时不能传此参数。' },
                hard: { type: 'boolean', description: '派活前按本次剩余工作所需的推理深度判断：可直接应用已有方法或先例、主要工作是执行调整和验证时为 false；必要信息已掌握，但已有方法不能直接解决，仍需深入推导或作出影响结果的关键判断时为 true。选 true 时简要说明具体哪个问题需要更深的推理。工作量、文件数和风险不单独决定难度；需求和步骤明确也不代表关键步骤容易完成。关键事实不明时先派 investigate，调查按自身工作判断难度。' },
                task: { type: 'string', description: '执行者看不到你和用户的对话。只写以下内容，不适用的省略：1. 任务目标；2. 用户的决定和偏好、已确认的事实、已排除的做法；3. 本任务特有的范围和限制；4. 完成标准；5. 报告里需要额外交代的内容。用户本条消息的附件由 Nodo 自动附上；更早的附件需要时写明路径。结论写在执行者最后的回复里，不要写报告文件；改文件的工作只派给会改文件的任务类型。' },
                session: { type: 'string', description: '仅可续用 taskId 所属会话，角色和难度须不变，最多续用两次。难度或角色变化、新目标、需要独立审查时省略，新开会话并交代已有改动、报告和剩余问题。' },
            } } },
    { name: 'nodo_interrupt', description: '停止本主控派出的一个执行，等待确认后返回真实结果。优先用 executionId；兼容 session 须唯一对应一次派活。二者只能填一个。用户只是问进度时不要停止。',
        inputSchema: { type: 'object', oneOf: [{ required: ['executionId'] }, { required: ['session'] }], properties: { executionId: { type: 'string' }, session: { type: 'string' } }, additionalProperties: false } },
    { name: 'nodo_task', description: '核对结果后验收任务、重新打开已完成/停止的任务，或修改未结束任务的 title、brief、parentId、dependsOn。complete 必须提供 reason 和属于该任务执行结果的 references；不能验收仍有待发送、运行中、未确认执行或未验收子任务的任务。revise 至少提供一个修改字段；任务已 done/stopped 时先 reopen。',
        inputSchema: { type: 'object', required: ['taskId', 'action'], oneOf: [
                { properties: { action: { const: 'complete' } }, required: ['reason', 'references'] },
                { properties: { action: { const: 'reopen' } } },
                { properties: { action: { const: 'revise' } }, anyOf: [{ required: ['title'] }, { required: ['brief'] }, { required: ['parentId'] }, { required: ['dependsOn'] }] },
            ], properties: { taskId: { type: 'string' }, action: { type: 'string', enum: ['complete', 'reopen', 'revise'] }, reason: { type: 'string' }, references: { type: 'array', items: { type: 'string' } }, title: { type: 'string', description: '新的任务标题，取首行，最长 80 字符。' }, brief: { type: 'string', description: '新的任务说明。' },
                parentId: { type: 'string', description: 'revise：本主控的父任务 id，空字符串清空。' },
                dependsOn: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'revise：本主控的前置任务 id，空数组清空。' },
            }, additionalProperties: false } },
];
export async function leadServer(call) {
    const { Server, CallToolRequestSchema, ListToolsRequestSchema } = await loadMcpSdk();
    const server = new Server({ name: 'nodo-lead', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => call(params.name, params.arguments ?? {}));
    return server;
}
