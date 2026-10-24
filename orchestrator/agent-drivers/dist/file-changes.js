import { resolve } from 'node:path';
export const CHANGE_LIMITS = Object.freeze({ files: 512, edits: 1024, bytes: 1024 * 1024 });
const operations = ['add', 'update', 'delete', 'move', 'unknown'];
const validPath = (value) => typeof value === 'string' && value.length > 0 && value.length <= 2000 && !value.includes('\0');
const size = (value) => Buffer.byteLength(JSON.stringify(value));
export function normalizeChanges(value) {
    if (!['edit-tools', 'workspace-snapshot'].includes(value?.scope) || value.coverage !== 'partial' || !Array.isArray(value.files))
        return null;
    const files = [];
    let truncated = value.files.length > CHANGE_LIMITS.files;
    let edits = 0;
    const paths = new Set();
    for (const file of value.files.slice(0, CHANGE_LIMITS.files)) {
        if (!validPath(file?.path) || paths.has(file.path) || !Array.isArray(file.edits))
            return null;
        paths.add(file.path);
        const changes = [];
        for (const edit of file.edits) {
            if (++edits > CHANGE_LIMITS.edits) {
                truncated = true;
                break;
            }
            if (!operations.includes(edit?.operation))
                return null;
            const clean = { operation: edit.operation };
            if (edit.availability !== undefined) {
                if (!['binary', 'oversized', 'coarse', 'unavailable'].includes(edit.availability))
                    return null;
                clean.availability = edit.availability;
            }
            if (edit.fromPath !== undefined) {
                if (!validPath(edit.fromPath))
                    return null;
                clean.fromPath = edit.fromPath;
            }
            for (const key of ['oldText', 'newText', 'diffText']) {
                if (edit[key] !== undefined) {
                    if (typeof edit[key] !== 'string' && !(key === 'oldText' && edit[key] === null && edit.operation === 'add'))
                        return null;
                    clean[key] = edit[key];
                }
            }
            changes.push(clean);
        }
        files.push({ path: file.path, edits: changes });
    }
    const count = Number.isSafeInteger(value.fileCount) && value.fileCount >= files.length ? value.fileCount : files.length;
    const body = { scope: value.scope, coverage: 'partial', fileCount: count, files,
        ...(validPath(value.cwd) ? { cwd: value.cwd } : {}),
        ...(typeof value.turnDiff === 'string' ? { turnDiff: value.turnDiff } : {}) };
    if (size(body) > CHANGE_LIMITS.bytes) {
        body.files = files.map(file => ({ path: file.path, edits: file.edits.map(({ operation, fromPath, availability }) => ({ operation, ...(fromPath ? { fromPath } : {}), ...(availability ? { availability } : {}) })) }));
        delete body.turnDiff;
        truncated = true;
    }
    return { body, truncated };
}
export function createFileChanges(cwd) {
    const calls = new Map();
    let truncated = false;
    let turnDiff;
    let retainedEdits = 0;
    return {
        add(id, files, confirmed) {
            if (!id || calls.has(id))
                return;
            if (calls.size >= CHANGE_LIMITS.edits) {
                truncated = true;
                return;
            }
            if (!confirmed) {
                calls.set(id, []);
                return;
            }
            if (!Array.isArray(files)) {
                truncated = true;
                return;
            }
            const clean = [];
            for (const file of files) {
                if (retainedEdits >= CHANGE_LIMITS.edits) {
                    truncated = true;
                    break;
                }
                if (!validPath(file?.path)) {
                    truncated = true;
                    continue;
                }
                const path = resolve(cwd, file.path);
                const normalized = normalizeChanges({ scope: 'edit-tools', coverage: 'partial', files: [{ path, edits: [file.edit] }] });
                if (!normalized) {
                    truncated = true;
                    continue;
                }
                truncated ||= normalized.truncated;
                clean.push(normalized.body.files[0]);
                retainedEdits += 1;
                if (clean.length >= CHANGE_LIMITS.files) {
                    truncated ||= files.length > clean.length;
                    break;
                }
            }
            calls.set(id, clean);
            if (size([...calls.values()]) > CHANGE_LIMITS.bytes) {
                for (const entries of calls.values())
                    for (const file of entries)
                        file.edits = file.edits.map(({ operation, fromPath }) => ({ operation, ...(fromPath ? { fromPath } : {}) }));
                truncated = true;
            }
        },
        diff(text) {
            if (typeof text !== 'string')
                return;
            if (Buffer.byteLength(text) <= CHANGE_LIMITS.bytes / 2)
                turnDiff = text;
            else {
                turnDiff = undefined;
                truncated = true;
            }
        },
        snapshot(turnId) {
            const grouped = new Map();
            for (const entries of calls.values())
                for (const file of entries) {
                    if (!grouped.has(file.path) && grouped.size >= CHANGE_LIMITS.files) {
                        truncated = true;
                        continue;
                    }
                    const edits = grouped.get(file.path) ?? [];
                    edits.push(...file.edits);
                    grouped.set(file.path, edits);
                }
            const normalized = normalizeChanges({ scope: 'edit-tools', coverage: 'partial', files: [...grouped].map(([path, edits]) => ({ path, edits })),
                cwd: resolve(cwd),
                ...(turnDiff !== undefined ? { turnDiff } : {}) });
            return { type: 'changes', turnId, presentation: { version: 1, kind: 'changes', mode: 'snapshot', body: normalized.body,
                    capture: truncated || normalized.truncated ? 'partial' : 'complete', ...(truncated || normalized.truncated ? { reason: 'source-limit' } : {}) } };
        },
    };
}
