import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { connect } from 'node:net';
const socket = process.env.NODO_LEAD_SOCKET;
const token = process.env.NODO_LEAD_TOKEN;
delete process.env.NODO_LEAD_SOCKET;
delete process.env.NODO_LEAD_TOKEN;
if (!socket || !token)
    process.exit(1);
const tools = [
    { name: 'nodo_board', description: '用于选择角色和查看历史。不要反复查表等待执行结束，结果会自动送来。默认只返回派活表。',
        inputSchema: { type: 'object', properties: { table: { type: 'string', enum: ['roles', 'delegations'] }, session: { type: 'string' } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: 'nodo_delegate', description: '受理任务或修改当前任务，本轮正常结束后发送。告诉用户已派给谁，然后结束本轮，结果会自动送来。本轮停止或出错则取消。',
        inputSchema: { type: 'object', required: ['type', 'hard', 'task'], additionalProperties: false, properties: {
                type: { type: 'string', description: '任务类型 id' }, hard: { type: 'boolean' },
                task: { type: 'string', description: '执行者看不到你和用户的对话。只写以下内容，不适用的省略：1. 任务目标；2. 用户的决定和偏好、已确认的事实、已排除的做法；3. 本任务特有的范围和限制；4. 完成标准；5. 报告里需要额外交代的内容。用户本条消息的附件由 Nodo 自动附上；更早的附件需要时写明路径。结论写在执行者最后的回复里，不要写报告文件；改文件的工作只派给会改文件的任务类型。' },
                session: { type: 'string', description: '同一目标返工、或改正在执行的任务时填；新目标、需要独立审查、原路径已证伪时不填。' },
            } } },
    { name: 'nodo_interrupt', description: '只停止本主控当前执行中的派活，等待确认结束后返回。要改需求用 nodo_delegate 带当前会话；用户只是问进度时不要停止。',
        inputSchema: { type: 'object', required: ['session'], properties: { session: { type: 'string' } }, additionalProperties: false } },
];
const server = new Server({ name: 'nodo-lead', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => new Promise(resolve => {
    const client = connect(socket);
    client.setEncoding('utf8');
    let buffer = '';
    const fail = () => {
        client.destroy();
        resolve({ isError: true, content: [{ type: 'text', text: 'Nodo 本地通道不可用、超时或响应无效' }] });
    };
    client.setTimeout(25_000, fail);
    client.on('connect', () => client.write(JSON.stringify({ token, name: params.name, arguments: params.arguments ?? {} }) + '\n'));
    client.on('data', chunk => {
        buffer += chunk;
        if (!buffer.includes('\n'))
            return;
        try {
            resolve(JSON.parse(buffer.split('\n', 1)[0]));
        }
        catch {
            fail();
        }
        client.destroy();
    });
    client.on('error', fail);
    client.on('close', fail);
}));
await server.connect(new StdioServerTransport());
