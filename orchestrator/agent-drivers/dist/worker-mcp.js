import { fileURLToPath } from 'node:url';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { loadMcpSdk } from './role-mcp.js';
export const WORKER_TOOLS = ['nodo_report', 'nodo_context'];
export function workerMcp(socket, tokenFile) {
    return [{ name: 'nodo_worker', command: process.execPath,
            args: [fileURLToPath(new URL('./worker-server.js', import.meta.url))],
            env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }, { name: 'NODO_WORKER_SOCKET', value: socket }, { name: 'NODO_WORKER_TOKEN_FILE', value: tokenFile }],
        }];
}
const text = { type: 'string', minLength: 1 };
const reportSchema = {
    type: 'object', additionalProperties: false, required: ['outcome', 'summary', 'changed', 'verified', 'issues'],
    properties: {
        outcome: { enum: ['done', 'blocked', 'failed'] }, summary: { ...text, maxLength: 300 },
        changed: { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: false, required: ['path', 'op'],
                properties: { path: text, op: { enum: ['add', 'update', 'delete', 'move', 'unknown'] } } } },
        verified: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['result'],
                properties: { command: text, result: { enum: ['pass', 'fail', 'not-run'] }, note: text } } },
        issues: { type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: false, required: ['text', 'blocking'],
                properties: { text, blocking: { type: 'boolean' } } } },
        reviewFlags: { type: 'object', additionalProperties: false, required: ['crossModule', 'publicInterface', 'dataFormat', 'security'],
            properties: Object.fromEntries(['crossModule', 'publicInterface', 'dataFormat', 'security'].map(key => [key, { type: 'boolean' }])) },
        verdict: { enum: ['pass', 'fail'] },
        findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['category', 'severity', 'text'], properties: {
                    category: { enum: ['crossModule', 'publicInterface', 'dataFormat', 'security', 'other'] }, severity: { enum: ['high', 'medium', 'low'] }, text, where: text, evidence: text,
                } } },
        answers: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['n', 'text'],
                properties: { n: { type: 'integer', minimum: 1 }, text } } },
        next: { ...text, maxLength: 200 },
    },
};
export const validateWorkerReport = new AjvJsonSchemaValidator().getValidator(reportSchema);
const tools = [
    { name: 'nodo_report', description: '回报当前执行。summary 最多 300 字；最后一份生效，旧摘要保留三份。reviewFlags 可选。审查必填 verdict，fail 必填 findings；其他阶段禁止 verdict/findings。补答必填 answers，按问题编号逐条回答。', inputSchema: reportSchema },
    { name: 'nodo_context', description: '只读本工作项材料及输入中给出的白名单句柄。read 传 sourceId 或 executionId；list 列出可读材料。offset/limit 按 UTF-16 分页，最多 16000。',
        inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
                action: { enum: ['list', 'read'] }, sourceId: text, executionId: text,
                offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 16000 },
            } }, annotations: { readOnlyHint: true } },
];
export async function workerServer(call) {
    const { Server, CallToolRequestSchema, ListToolsRequestSchema } = await loadMcpSdk();
    const server = new Server({ name: 'nodo-worker', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => call(params.name, params.arguments ?? {}));
    return server;
}
