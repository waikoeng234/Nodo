import { createAcpDriver } from '../acp/core.js';
import { connectDsh, findDshExecutable, initializeDsh, validateDshOptions } from './config.js';
import { dshStorage, dshInstructionsPatch } from './storage.js';
import { dshError } from './errors.js';
import { createNativeDshDriver } from './native.js';
export { dshInfo, validateDshOptions, checkDsh, findDshExecutable, describeDsh } from './config.js';
export { scanDsh } from './catalog.js';
export { scanDshCommands } from './skills.js';
export function createDshDriver({ nativeHost, name, sessionName, workspaceId, workspaceName, workspaceKey, allowEmptyResume, identityFiles, identityOwner, leadMcpServers, ...options } = {}) {
    if (nativeHost?.workspaceRegistry && nativeHost?.sessionController)
        return createNativeDshDriver({ ...options, nativeHost: nativeHost, name, sessionName, workspaceId, workspaceName });
    if (nativeHost && !options.bin)
        throw new Error('DSH native workspace/session services are unavailable on this host');
    return createAcpDshDriver(options);
}
export function createAcpDshDriver({ cwd, env = {}, model, thinking, permission, driverSessionId, storageDir, instructions, instructionDir, ...raw } = {}) {
    if (permission !== undefined)
        throw new Error('DSH ACP cannot set a session permission tier. Clear the override to use the DSH profile permissions, or use the native host.');
    const { onEvent, ...config } = raw;
    const options = validateDshOptions(config);
    const storage = dshStorage(storageDir, driverSessionId);
    const identity = dshInstructionsPatch(instructionDir, storage.patch, instructions);
    return createAcpDriver({ cwd, onEvent, driverSessionId: storage.sessionId }, {
        id: 'dsh', label: 'DSH', fileChanges: true,
        initialize: initializeDsh, savedId: storage.savedId,
        instructionMode: identity.instructionMode, error: dshError,
        stopReason: stop => stop === 'end_turn' ? 'done' : 'error',
        dispose: () => identity.dispose(),
        connect(callbacks) {
            const executable = findDshExecutable(options.bin);
            if (!executable)
                throw new Error('DSH executable not found. Edit the profile CLI path or install dsh separately.');
            return connectDsh({ executable, cwd, env, options, patch: identity.patch, ...callbacks });
        },
        async configure({ peer, sessionId, attached }) {
            let configOptions = attached.configOptions;
            if (model) {
                const option = configOptions?.find(item => item.id === 'model');
                const choices = option?.options?.flatMap(item => item.options ?? [item]) ?? [];
                const matches = choices.filter(item => item.value === model || item.name === model);
                if (matches.length !== 1)
                    throw new Error('Model selector must match exactly one advertised DSH ACP model value or name');
                configOptions = (await peer.request('session/set_config_option', { sessionId, configId: option.id, value: matches[0].value })).configOptions;
            }
            if (thinking) {
                const option = configOptions?.find(item => item.id === 'reasoning_effort');
                const choices = option?.options?.flatMap(item => item.options ?? [item]) ?? [];
                if (!choices.some(item => item.value === thinking))
                    throw new Error('The selected DSH model does not offer this thinking level');
                await peer.request('session/set_config_option', { sessionId, configId: option.id, value: thinking });
            }
        },
    });
}
