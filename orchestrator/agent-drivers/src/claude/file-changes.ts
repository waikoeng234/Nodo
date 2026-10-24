import type { FileChangeEdit } from '../spi.js'

type ClaudeFileInput = { notebook_path?: unknown; file_path?: unknown }
type ClaudeFileResult = {
  staged?: unknown; error?: unknown; notebook_path?: unknown; filePath?: unknown; type?: unknown
  content?: unknown; originalFile?: unknown; oldString?: unknown; newString?: unknown
  gitDiff?: { patch?: unknown }; original_file?: unknown; updated_file?: unknown
}

export function claudeFileChanges(name: string, input: unknown, result: ClaudeFileResult | null | undefined): { path: string; edit: FileChangeEdit }[] {
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.staged === true || result.error) return []
  const path = name === 'NotebookEdit' ? result.notebook_path : result.filePath
  const requested = name === 'NotebookEdit' ? (input as ClaudeFileInput | null | undefined)?.notebook_path : (input as ClaudeFileInput | null | undefined)?.file_path
  if (typeof path !== 'string' || path !== requested) return []
  if (name === 'Write' && ['create', 'update'].includes(result.type as string) && typeof result.content === 'string') {
    const edit: FileChangeEdit = { operation: result.type === 'create' ? 'add' : 'update', newText: result.content }
    if (typeof result.originalFile === 'string' || result.type === 'create' && result.originalFile === null) edit.oldText = result.originalFile
    return [{ path, edit }]
  }
  if (name === 'Edit' && typeof result.oldString === 'string' && typeof result.newString === 'string') {
    return [{ path, edit: { operation: 'update', ...(typeof result.gitDiff?.patch === 'string' ? { diffText: result.gitDiff.patch } : {}) } }]
  }
  if (name === 'NotebookEdit' && typeof result.original_file === 'string' && typeof result.updated_file === 'string') {
    return [{ path, edit: { operation: 'update', oldText: result.original_file, newText: result.updated_file } }]
  }
  return []
}
