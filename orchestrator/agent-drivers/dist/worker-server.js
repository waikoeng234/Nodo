import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { workerServer } from './worker-mcp.js';
const socket = process.env.NODO_WORKER_SOCKET;
const tokenFile = process.env.NODO_WORKER_TOKEN_FILE;
delete process.env.NODO_WORKER_SOCKET;
delete process.env.NODO_WORKER_TOKEN_FILE;
if (!socket || !tokenFile)
    process.exit(1);
const server = await workerServer(async (name, args) => {
    let token;
    try {
        token = readFileSync(tokenFile, 'utf8').trim();
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
        client.on('connect', () => client.write(JSON.stringify({ token, name, arguments: args }) + '\n'));
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
