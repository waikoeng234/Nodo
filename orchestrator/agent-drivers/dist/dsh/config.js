import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { cliVersion, findExecutable, invalidConfig, validateBin, validateWorkspace } from '../cli.js';
import { jsonRpcProcess } from '../json-rpc-process.js';
import { initializeAcp } from '../acp/core.js';
import { nativeDshPermissions, nativeDshCompaction } from './native-services.js';
export const dshInfo = {
    id: 'dsh', label: 'DeepSeek Harness CLI', command: 'dsh', requiresCwd: true,
    description: 'Uses local dsh over ACP with existing model and credential settings. Running messages queue.',
    fields: [
        { name: 'bin', target: 'engineOptions', label: 'CLI executable (optional)', type: 'text', placeholder: 'Auto-detect dsh; or enter an absolute path' },
        { name: 'profile', target: 'engineOptions', label: 'DSH ACP profile', type: 'text', default: 'acp', placeholder: 'acp (must provide the ACP stdio service)' },
        { name: 'home', target: 'engineOptions', label: 'DSH home (optional)', type: 'text', placeholder: 'Leave blank to use existing DSH_HOME / ~/.dsh' },
        { name: 'model', target: 'profile', label: 'Model selector (optional)', type: 'text', placeholder: 'Use DSH settings; or ACP value such as ["deepseek","deepseek-chat"]' },
    ],
    capabilities: { resume: true, steer: false, permissions: true, questions: false, commands: true, permissionModes: [] },
};
export function describeDsh(host) {
    if (!host?.workspaceRegistry || !host?.sessionController)
        return dshInfo;
    return { ...dshInfo, label: 'DeepSeek Harness (native)', command: undefined, nativeRuntime: true,
        capabilities: { ...dshInfo.capabilities, steer: true,
            permissionModes: Object.keys(nativeDshPermissions(host)),
            compact: typeof nativeDshCompaction(host)?.compactNow === 'function',
        },
        description: 'Uses Desktop workspace/session services and its existing model settings.',
        fields: dshInfo.fields.filter(field => field.name === 'model').map(field => ({ ...field, placeholder: 'Use Desktop model settings; or ["provider","model"]' })),
    };
}
export function validateDshOptions(raw = {}) {
    for (const key of Object.keys(raw))
        if (!['bin', 'profile', 'home'].includes(key))
            throw invalidConfig(`Unsupported DSH option: ${key}`);
    const bin = validateBin(raw.bin);
    const profile = raw.profile ?? 'acp';
    if (typeof profile !== 'string' || !/^[a-zA-Z0-9][\w-]{0,63}$/.test(profile))
        throw invalidConfig('DSH ACP profile must be a simple profile name');
    if (raw.home !== undefined && (typeof raw.home !== 'string' || !isAbsolute(raw.home) || raw.home.includes('\0')))
        throw invalidConfig('DSH home must be an absolute directory');
    return { ...(bin ? { bin } : {}), profile, ...(raw.home ? { home: raw.home } : {}) };
}
// Reuse an already installed npm CLI when Desktop has no dsh on PATH. Never
// invoke npx, install a package, or import Desktop's private runtime files.
export function findDshExecutable(bin = 'dsh', { home = homedir(), path = process.env.PATH, defaults } = {}) {
    const direct = findExecutable(bin, { home, path, defaults });
    if (direct || bin !== 'dsh')
        return direct;
    const cache = join(home, '.npm/_npx');
    try {
        return readdirSync(cache).flatMap(id => {
            try {
                const root = join(cache, id, 'node_modules');
                const manifest = JSON.parse(readFileSync(join(root, '@deepseek-ai/dsh/package.json'), 'utf8'));
                const executable = findExecutable(join(root, '.bin/dsh'));
                return manifest.name === '@deepseek-ai/dsh' && executable ? [{ executable, at: statSync(join(root, '@deepseek-ai/dsh/package.json')).mtimeMs }] : [];
            }
            catch {
                return [];
            }
        }).sort((a, b) => b.at - a.at)[0]?.executable;
    }
    catch {
        return undefined;
    }
}
export function connectDsh({ executable, cwd, env = {}, options, patch, ...callbacks }) {
    return jsonRpcProcess({ bin: executable, args: ['--profile', options.profile, ...(patch ? ['--patch', patch] : [])], cwd,
        env: { ...env, ...(options.home ? { DSH_HOME: options.home } : {}) }, jsonrpc: '2.0', ...callbacks });
}
export async function initializeDsh(peer) {
    return initializeAcp(peer, {}, { name: 'dsh-nodo', version: '0.1.0' });
}
export async function checkDsh({ cwd, engineOptions = {}, nativeHost } = {}) {
    if (nativeHost?.workspaceRegistry && nativeHost?.sessionController)
        return { engine: 'dsh', ok: true, checks: [{ label: 'Native runtime', ok: true, message: 'Desktop workspace/session controller is available; model credentials are verified by a conversation.' }] };
    const checks = [];
    try {
        validateWorkspace(cwd, true);
        checks.push({ label: 'Working directory', ok: true, message: cwd });
    }
    catch (error) {
        checks.push({ label: 'Working directory', ok: false, message: error.message });
    }
    const options = validateDshOptions(engineOptions);
    const executable = findDshExecutable(options.bin);
    if (!executable)
        return { engine: 'dsh', ok: false, checks: [...checks, { label: 'CLI', ok: false, message: 'DSH executable not found. Enter the path to an installed dsh CLI.' }] };
    let version;
    try {
        version = await cliVersion(executable);
        checks.push({ label: 'CLI', ok: true, message: `${version} · ${executable}` });
    }
    catch {
        return { engine: 'dsh', ok: false, executable, checks: [...checks, { label: 'CLI', ok: false, message: 'CLI version check failed or timed out.' }] };
    }
    if (checks.some(check => !check.ok))
        return { engine: 'dsh', ok: false, executable, version, checks };
    const peer = connectDsh({ executable, cwd, options, onRequest: request => peer.refuse(request.id) });
    try {
        const capabilities = await initializeDsh(peer);
        checks.push({ label: 'Protocol', ok: true, message: `DSH ACP connected (${options.profile}); resume ${capabilities.sessionCapabilities?.resume ? 'available' : capabilities.loadSession ? 'via session/load' : 'unavailable'}` });
        checks.push({ label: 'Model / credentials', ok: null, message: 'ACP has no credential-status query. Existing DSH settings will be used; a conversation is needed to verify the model route.' });
    }
    catch {
        checks.push({ label: 'Protocol', ok: false, message: 'Could not connect to ACP. Verify that the selected DSH profile provides ACP stdio.' });
    }
    finally {
        peer.dispose();
    }
    return { engine: 'dsh', ok: checks.every(check => check.ok !== false), executable, version, checks };
}
