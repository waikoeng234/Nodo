// Which models this machine's ZCode offers, and which thinking levels each one
// takes. ZCode has no model-list method: the catalog is a session snapshot field,
// and only `session/create` and `session/resume` carry the full list. A scan
// therefore opens one session, reads `settings.model.available` (each entry
// carries its own levels and default) and closes that session again.
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { connectZcode, findZcodeExecutable } from './native.js';
const route = (providerId, modelId) => `${providerId}$${modelId}`;
export async function scanZcode({ engineOptions = {}, cwd } = {}) {
    const executable = findZcodeExecutable(engineOptions.bin ?? 'zcode');
    if (!executable)
        return { source: 'ZCode CLI not found', models: [] };
    const workdir = typeof cwd === 'string' && isAbsolute(cwd) ? cwd : homedir();
    const peer = connectZcode({ executable, cwd: workdir, onRequest: (request) => {
            if (request.method === 'session/requestRuntimePreferences')
                return peer.refuse(request.id);
            if (request.method === 'interaction/requestOfficialMcpAuthHeaders')
                return peer.reply(request.id, { headers: {} });
            return peer.refuse(request.id);
        } });
    try {
        const created = await peer.request('session/create', { workspace: { workspacePath: workdir, workspaceKey: workdir }, mode: 'build' });
        const sessionId = created.session?.sessionId ?? created.sessionId;
        const models = [];
        for (const entry of created.settings?.model?.available ?? []) {
            const providerId = entry?.ref?.providerId;
            const modelId = entry?.ref?.modelId;
            if (typeof providerId !== 'string' || providerId === '' || typeof modelId !== 'string' || modelId === '')
                continue;
            const thinking = (entry.reasoning?.levels ?? []).flatMap((level) => {
                if (typeof level?.value !== 'string' || level.value === '')
                    return [];
                return [{ id: level.value, ...(typeof level.label === 'string' && level.label !== '' && level.label !== level.value ? { label: level.label } : {}) }];
            });
            const preferred = entry.reasoning?.defaultLevel;
            // The label is the model's own name, the provider the section it sits
            // under; the route id still carries the provider for the value sent back.
            const providerLabel = entry.providerLabel || providerId;
            models.push({ id: route(providerId, modelId), label: String(entry.label ?? modelId),
                ...(providerLabel ? { group: String(providerLabel) } : {}),
                ...(thinking.length ? { thinking } : {}), ...(thinking.some(level => level.id === preferred) ? { defaultThinking: String(preferred) } : {}) });
        }
        const current = created.settings?.model?.current;
        const defaultModel = current?.providerId && current?.modelId ? route(current.providerId, current.modelId) : undefined;
        if (typeof sessionId === 'string' && sessionId !== '')
            await peer.request('session/close', { sessionId }).catch(() => { });
        // The app-server fail-closes account (subscription) providers for foreign
        // spawns, so its list only ever carries custom providers.
        return {
            source: models.length === 0
                ? 'ZCode 未向本机 app-server 暴露任何模型：订阅账号模型仅 ZCode 应用内部可用，在 ZCode 管理模型里添加自定义供应商后会显示在这里'
                : 'ZCode session model list',
            ...(defaultModel ? { defaultModel } : {}),
            models,
        };
    }
    finally {
        peer.dispose();
    }
}
