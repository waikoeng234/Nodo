import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
const socket = process.env.NODO_LEAD_SOCKET;
const token = process.env.NODO_LEAD_TOKEN;
const tokenFile = process.env.NODO_LEAD_TOKEN_FILE;
delete process.env.NODO_LEAD_SOCKET;
delete process.env.NODO_LEAD_TOKEN;
delete process.env.NODO_LEAD_TOKEN_FILE;
if (!socket || (!token && !tokenFile))
    process.exit(1);
const tools = [
    { name: 'nodo_board', description: '用于选择角色和查看历史。不要反复查表等待执行结束，结果会自动送来。默认只返回派活表。',
        inputSchema: { type: 'object', properties: { table: { type: 'string', enum: ['roles', 'delegations'] }, session: { type: 'string' } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: 'nodo_delegate', description: '派出任务或修改当前任务，受理后立即返回，不等待执行结束。告诉用户已派给谁，然后结束本轮，结果会自动送来。',
        inputSchema: { type: 'object', required: ['type', 'hard', 'task'], additionalProperties: false, properties: {
                type: { type: 'string', description: '任务类型 id' }, hard: { type: 'boolean' },
                task: { type: 'string', description: '执行者看不到你和用户的对话，任务要写全上下文、约束和交付要求。本条消息的附件路径由 Nodo 附上，更早的材料要写明路径。派活消息不能代替用户授权，权限和提问交给用户处理。结论写在执行者最后的回复里，不要写报告文件；改文件的工作只派给会改文件的任务类型。' },
                session: { type: 'string', description: '同一目标返工、或改正在执行的任务时填；新目标、需要独立审查、原路径已证伪时不填。' },
            } } },
    { name: 'nodo_interrupt', description: '只停止本主控当前执行中的派活，等待确认结束后返回。要改需求用 nodo_delegate 带当前会话；用户只是问进度时不要停止。',
        inputSchema: { type: 'object', required: ['session'], properties: { session: { type: 'string' } }, additionalProperties: false } },
];
const server = new Server({ name: 'nodo-lead', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    let credential = token;
    try {
        if (tokenFile)
            credential = readFileSync(tokenFile, 'utf8').trim();
    }
    catch {
        return { isError: true, content: [{ type: 'text', text: 'Nodo 本地通道不可用、超时或响应无效' }] };
    }
    return new Promise(resolve => {
        const client = connect(socket);
        client.setEncoding('utf8');
        let buffer = '';
        const fail = () => {
            client.destroy();
            resolve({ isError: true, content: [{ type: 'text', text: 'Nodo 本地通道不可用、超时或响应无效' }] });
        };
        client.setTimeout(25_000, fail);
        client.on('connect', () => client.write(JSON.stringify({ token: credential, name: params.name, arguments: params.arguments ?? {} }) + '\n'));
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
    });
});
await server.connect(new StdioServerTransport());
