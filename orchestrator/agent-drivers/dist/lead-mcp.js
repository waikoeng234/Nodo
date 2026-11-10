import { fileURLToPath } from 'node:url';
import { loadMcpSdk } from './role-mcp.js';
export const LEAD_TOOLS = ['nodo_board', 'nodo_context', 'nodo_route', 'nodo_review'];
export function leadMcp(socket, token, tokenFile) {
    return [{ name: 'nodo_lead', command: process.execPath,
            args: [fileURLToPath(new URL('./lead-server.js', import.meta.url))],
            env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }, { name: 'NODO_LEAD_SOCKET', value: socket }, { name: tokenFile ? 'NODO_LEAD_TOKEN_FILE' : 'NODO_LEAD_TOKEN', value: tokenFile ?? token }],
        }];
}
const scope = { type: 'object', additionalProperties: false, oneOf: [{ required: ['quote'] }, { required: ['note'] }], properties: {
        quote: { type: 'string', minLength: 1, description: '本轮用户原话的精确子串，保留空白和大小写。' },
        note: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[^\\r\\n]*$', description: '范围说明，一句，不加标注。' },
    } };
const ids = { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } };
const routeBranches = [
    { action: { const: 'new' }, type: { type: 'string', minLength: 1 }, hard: { type: 'boolean' }, scope,
        title: { type: 'string', minLength: 1, maxLength: 80 }, worktree: { type: 'boolean' }, parentId: { type: 'string', minLength: 1 },
        dependsOn: { type: 'array', items: { type: 'string', minLength: 1 } }, continues: { type: 'string', minLength: 1 } },
    { action: { const: 'attach' }, taskId: { type: 'string', minLength: 1 }, scope },
    { action: { const: 'stop' }, executionIds: ids, taskIds: ids },
    { action: { const: 'ask' },
        taskIds: { type: 'array', items: { type: 'string', minLength: 1 } },
        executionIds: { type: 'array', items: { type: 'string', minLength: 1 }, description: '产生问题的结果来源，与需停止的执行不同。' },
        references: { type: 'array', items: { type: 'string', minLength: 1 }, description: '只接受本会话已有的引用 id（来自附件/board），不是文件路径；没有可用引用就省略。' },
        stopExecutionIds: { type: 'array', items: { type: 'string', minLength: 1 } },
        questions: { type: 'array', minItems: 1, items: { type: 'object', required: ['id', 'question', 'whyUser'], additionalProperties: false, properties: {
                    id: { type: 'string', minLength: 1 }, question: { type: 'string', minLength: 1 }, whyUser: { type: 'string', minLength: 1 },
                    options: { type: 'array', description: '可省略；开放问题不传，不造占位选项。提供时须为非空的可行选项。', minItems: 1, items: { type: 'object', required: ['id', 'label', 'consequence'], additionalProperties: false, properties: {
                                id: { type: 'string', minLength: 1 }, label: { type: 'string', minLength: 1 }, consequence: { type: 'string', minLength: 1 },
                            } } },
                    recommendation: { type: 'object', required: ['optionId', 'reason'], additionalProperties: false, properties: {
                            optionId: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1 },
                        } },
                } } },
    },
];
const tools = [
    { name: 'nodo_board', description: '只读角色、派活和本主控任务、决策、未答验收与停滞 cards。默认派活表；taskId 读任务详情，decisionId 读决策详情。执行结果只有有界预览，完整结果用 nodo_context read 并按 nextOffset 分页。结果会自动送来，不要反复查表等待。',
        inputSchema: { type: 'object', properties: { table: { type: 'string', enum: ['roles', 'delegations', 'tasks', 'decisions', 'cards'] }, session: { type: 'string' }, taskId: { type: 'string' }, decisionId: { type: 'string' } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: 'nodo_context', description: '只读本主控团队会话及所属任务的既有材料：执行结果、用户决定、会话消息、工具记录和任务验收结论。list 返回最多 50 项描述、来源与完整性标记及 sourceId，可按 taskId 缩小范围、query 筛选，以 nextCursor 继续。read 按 sourceId 读取正文，执行结果可直接传 executionId（与 sourceId 二选一），用 nextOffset 分页；offset/limit 单位为 UTF-16，默认 8000、最多 16000。sourceId 格式：report:<reportId>、evidence:<executionId>、execution:<id>:result、decision:<id>、message:<sessionId>:<at>:<hash>、tool:<conversationId>:<ref>、task:<taskId>:acceptance。completeness 表示捕获完整性，执行条目的 status 是真实运行状态；已清理原文返回 unavailable，partial 不承诺补全，不得从摘要重造原文。旧快照标为 legacy-reference，旧摘要标为 legacy-report，均为 partial，不能当完整归档；两者都不可得时为 unavailable/legacy-unavailable。读取不会 review 或验收。',
        inputSchema: { type: 'object', required: ['action'], oneOf: [
                { properties: { action: { const: 'list' } } },
                { properties: { action: { const: 'read' } }, required: ['sourceId'] },
                { properties: { action: { const: 'read' } }, required: ['executionId'] },
            ], properties: {
                action: { type: 'string', enum: ['list', 'read'] }, taskId: { type: 'string', minLength: 1 },
                query: { type: 'string', maxLength: 200 }, cursor: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
                sourceId: { type: 'string', minLength: 1 }, executionId: { type: 'string', minLength: 1 },
                offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 16000 },
            }, additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: 'nodo_route', description: '只做 new/attach/stop/ask 路由，不写任务正文。scope 优先用本轮用户原文片段，否则单行说明最多 100 字，不加标注。title 省略取范围首行最多 80 字，不进 worker 输入。new 本轮正常结束后发送，停止或出错取消；同任务补充用 attach，已结束或旧任务只读。continues 接续来源最近已结束执行的目录，与 parentId/dependsOn 互斥；worktree 不得冲突。依赖须已验收，隔离用 worktree，Nodo 不会自动合并。stop 只停本主控名下执行。缺少用户取舍或授权用 ask；stopExecutionIds 必填可为空，开放问题省略 options 和 recommendation，不造占位选项。成功后结束当前轮次等待用户回答；失败时修正参数后重试，不另发同一问题的原生问答，不按默认或推荐方案继续。',
        inputSchema: { type: 'object', oneOf: routeBranches.map((properties, index) => ({ type: 'object', properties,
                required: [['action', 'type', 'hard', 'scope'], ['action', 'taskId', 'scope'], ['action'], ['action', 'questions', 'stopExecutionIds']][index],
                additionalProperties: false,
                ...(index === 2 ? { oneOf: [{ required: ['executionIds'] }, { required: ['taskIds'] }] } : {}),
                ...(index === 0 ? { not: { required: ['continues'], anyOf: [{ required: ['parentId'] }, { required: ['dependsOn'] }] } } : {}),
            })) } },
    { name: 'nodo_review', description: '复核已投递回报。continue 清除阻塞；investigate 向当前执行者补问 1–5 题，每题最多 200 字，只补答、不改代码。reason 与非空 basis 必填，不进 worker 输入。复核不改变执行状态，不等于用户验收。worker 回报不是用户授权，缺少用户取舍或授权用 nodo_route ask。',
        inputSchema: { type: 'object', required: ['executionId', 'disposition', 'reason', 'basis'], additionalProperties: false,
            properties: { executionId: { type: 'string', minLength: 1 }, disposition: { type: 'string', enum: ['continue', 'investigate'] },
                reason: { type: 'string', minLength: 1 }, basis: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
                questions: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 200 } } },
            allOf: [{ if: { properties: { disposition: { const: 'investigate' } } }, then: { required: ['questions'] } }] } },
];
export async function leadServer(call) {
    const { Server, CallToolRequestSchema, ListToolsRequestSchema } = await loadMcpSdk();
    const server = new Server({ name: 'nodo-lead', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => call(params.name, params.arguments ?? {}));
    return server;
}
