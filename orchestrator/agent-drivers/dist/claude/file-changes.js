import { loadDiff, replacementEdit } from '../file-changes.js';
export function claudeFileChanges(name, input, result) {
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.staged === true || result.error)
        return [];
    const path = name === 'NotebookEdit' ? result.notebook_path : result.filePath;
    const requested = name === 'NotebookEdit' ? input?.notebook_path : input?.file_path;
    if (typeof path !== 'string' || path !== requested)
        return [];
    const hunks = result.structuredPatch;
    const patch = typeof result.gitDiff?.patch === 'string' && result.gitDiff.patch !== '' ? result.gitDiff.patch
        : Array.isArray(hunks) && hunks.length && hunks.every(hunk => hunk && ['oldStart', 'oldLines', 'newStart', 'newLines'].every(key => Number.isSafeInteger(hunk[key]) && hunk[key] >= 0)
            && Array.isArray(hunk.lines) && hunk.lines.every((line) => typeof line === 'string' && /^[ +\-\\]/.test(line)))
            ? loadDiff()?.formatPatch({ oldFileName: path, newFileName: path, oldHeader: undefined, newHeader: undefined, hunks: hunks }) : undefined;
    if (name === 'Write' && ['create', 'update'].includes(result.type) && typeof result.content === 'string') {
        const edit = { operation: result.type === 'create' ? 'add' : 'update', newText: result.content };
        if (typeof result.originalFile === 'string' || result.type === 'create' && result.originalFile === null)
            edit.oldText = result.originalFile;
        else if (patch !== undefined)
            return [{ path, edit: { operation: edit.operation, diffText: patch } }];
        return [{ path, edit }];
    }
    if (name === 'Edit') {
        if (patch !== undefined)
            return [{ path, edit: { operation: 'update', diffText: patch } }];
        if (typeof result.oldString === 'string' && typeof result.newString === 'string')
            return [{ path, edit: replacementEdit(path, result.oldString, result.newString) }];
    }
    if (name === 'NotebookEdit' && typeof result.original_file === 'string' && typeof result.updated_file === 'string') {
        return [{ path, edit: { operation: 'update', oldText: result.original_file, newText: result.updated_file } }];
    }
    return [];
}
