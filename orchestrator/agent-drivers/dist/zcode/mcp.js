import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
const read = (path) => {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return {};
        throw error;
    }
};
const entries = (object) => Object.entries(object ?? {}).map(([name, value]) => ({ name, value }));
// session mcpServers replaces configured servers; never discard an option the
// protocol cannot carry, or bypass project-specific cwd and trust handling.
export function zcodeMcpServers({ cwd, env = {}, includeProject = false }) {
    try {
        const projects = [];
        for (let path = resolve(cwd);; path = dirname(path)) {
            const servers = Object.assign({}, ...['zcode.json', '.zcode/config.json'].map(file => read(join(path, file)).mcp?.servers));
            if (Object.keys(servers).length) {
                if (!includeProject)
                    return;
                projects.unshift(servers);
            }
            if (path === dirname(path))
                break;
        }
        const config = read(join(env.HOME ?? process.env.HOME ?? homedir(), '.zcode/cli/config.json'));
        const configured = Object.assign({}, config.mcp?.servers, ...projects);
        if (config.features?.mcp === false || Object.hasOwn(configured, 'nodo_role'))
            return;
        const servers = [];
        for (const [name, server] of Object.entries(configured)) {
            if (server.enabled === false)
                continue;
            const stdio = server.type === 'stdio' || (!server.type && server.command);
            const fields = stdio ? ['type', 'command', 'args', 'env', 'enabled', 'timeoutMs', 'protocolVersion'] : ['type', 'url', 'headers', 'oauth', 'enabled', 'timeoutMs', 'protocolVersion'];
            if (Object.keys(server).some(key => !fields.includes(key)) || (!stdio && !['http', 'sse'].includes(server.type)))
                return;
            const common = { name, ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}), ...(server.protocolVersion ? { protocolVersion: server.protocolVersion } : {}) };
            servers.push(stdio ? { ...common, command: server.command, args: server.args ?? [], env: entries(server.env) }
                : { ...common, type: server.type, url: server.url, headers: entries(server.headers), ...(server.oauth ? { oauth: server.oauth } : {}) });
        }
        return servers;
    }
    catch {
        return undefined;
    }
}
