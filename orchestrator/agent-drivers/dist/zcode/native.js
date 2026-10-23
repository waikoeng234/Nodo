import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findExecutable, invalidConfig } from '../cli.js';
import { jsonRpcProcess } from '../json-rpc-process.js';
// The CLI ships inside the Desktop app bundle and is normally not on PATH.
const bundleCandidates = home => [
    join(home, 'Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'),
    '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
];
export function findZcodeExecutable(bin = 'zcode', { home = homedir(), path = process.env.PATH } = {}) {
    const direct = findExecutable(bin, { home, path });
    if (direct || bin !== 'zcode')
        return direct;
    return bundleCandidates(home).find(candidate => {
        try {
            accessSync(candidate, constants.X_OK);
            return statSync(candidate).isFile();
        }
        catch {
            return false;
        }
    });
}
// ZCode model selection is {providerId, modelId} on the wire; its picker spells
// it providerId$modelId because ids themselves may contain "/".
export function parseZcodeModel(raw) {
    const bad = reason => { throw invalidConfig(`ZCode model ${JSON.stringify(raw) ?? String(raw)} ${reason}: expected providerId$modelId or a JSON {"providerId","modelId"} object`); };
    if (raw === undefined || raw === null || raw === '')
        return undefined;
    let value = raw;
    if (typeof raw === 'string') {
        const text = raw.trim();
        if (text.startsWith('{')) {
            try {
                value = JSON.parse(text);
            }
            catch {
                bad('is not valid JSON');
            }
        }
        else {
            const parts = text.split('$');
            if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim())
                bad('is not a provider/model route');
            value = { providerId: parts[0], modelId: parts[1] };
        }
    }
    if (value === null || typeof value !== 'object' || typeof value.providerId !== 'string' || !value.providerId.trim() || typeof value.modelId !== 'string' || !value.modelId.trim()) {
        bad('has no provider and model id');
    }
    return { providerId: value.providerId.trim(), modelId: value.modelId.trim() };
}
// The CLI refuses to start until it can locate its built-in provider list; the
// ZCode app injects ZCODE_BUILTIN_PROVIDER_CONFIG_FILE into everything it spawns,
// so a foreign host has to resolve the newest copy under ~/.zcode itself.
const runtimeArch = { arm64: 'aarch64', x64: 'x86_64' };
export function zcodeProviderEnv({ home = homedir(), platform = process.platform, arch = runtimeArch[process.arch] ?? process.arch, env = process.env } = {}) {
    const configured = env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    if (configured) {
        try {
            if (statSync(configured).isFile())
                return {};
        }
        catch { /* stale path, resolve again */ }
    }
    let newest = null;
    try {
        const root = join(home, '.zcode/v2/runtime/provider', `${platform}-${arch}`);
        for (const version of readdirSync(root))
            for (const endpoint of readdirSync(join(root, version))) {
                const candidate = join(root, version, endpoint, 'zcode-builtin.json');
                try {
                    const at = statSync(candidate).mtimeMs;
                    if (!newest || at > newest.at)
                        newest = { path: candidate, at };
                }
                catch { /* half-removed runtime versions happen */ }
            }
    }
    catch { /* no ZCode runtime on this machine */ }
    return newest ? { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: newest.path } : {};
}
export function connectZcode({ executable, cwd, env, ...callbacks }) {
    return jsonRpcProcess({ bin: executable, args: ['app-server'], cwd, env: { ...zcodeProviderEnv(), ...env }, ...callbacks });
}
