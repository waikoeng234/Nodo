import { diffLines, formatPatch, parsePatch } from 'diff'
import type { StructuredPatch } from 'diff'

export interface DiffCounts { added: number; removed: number }
export interface FileEdit {
  operation: string
  oldText?: string | null
  newText?: string
  diffText?: string
  availability?: string
  fromPath?: string
}
export interface ChangedFileData { path: string; edits: FileEdit[] }
export interface ChangesBody {
  scope: string
  coverage?: string
  cwd?: string
  fileCount: number
  files: ChangedFileData[]
  turnDiff?: string
}

export function parsedPatch(text: string): StructuredPatch[] | null {
  try {
    const patches = parsePatch(text)
    return patches.length && patches.every(patch => patch.hunks.length > 0 && patch.hunks.every(hunk =>
      Number.isSafeInteger(hunk.oldStart) && Number.isSafeInteger(hunk.newStart)
      && hunk.oldStart >= 0 && hunk.newStart >= 0)) ? patches : null
  } catch { return null }
}

export function patchCounts(patches: readonly StructuredPatch[]): DiffCounts {
  const total = { added: 0, removed: 0 }
  for (const patch of patches) for (const hunk of patch.hunks) for (const line of hunk.lines) {
    if (line.startsWith('+')) total.added++
    if (line.startsWith('-')) total.removed++
  }
  return total
}

export const relativeFile = (path: string, root?: string) => root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path

export function editCounts(edit: FileEdit): DiffCounts | undefined {
  if (typeof edit.oldText === 'string' && typeof edit.newText === 'string'
    || edit.operation === 'add' && edit.oldText === null && typeof edit.newText === 'string') {
    const changes = diffLines(edit.oldText ?? '', edit.newText!, { timeout: 40, maxEditLength: 10000 })
    if (!changes) return undefined
    return changes.reduce((counts, change) => ({ added: counts.added + (change.added ? change.count : 0),
      removed: counts.removed + (change.removed ? change.count : 0) }), { added: 0, removed: 0 })
  }
  const patch = typeof edit.diffText === 'string' ? parsedPatch(edit.diffText) : null
  return patch ? patchCounts(patch) : undefined
}

// 同一文件的相邻编辑互为前后像时，按首尾一对求净变更。
export function chainedEdits(edits: FileEdit[]): FileEdit[] {
  return edits.length > 1 && edits.every((edit, index) => typeof edit.newText === 'string'
    && (typeof edit.oldText === 'string' || edit.operation === 'add' && edit.oldText === null)
    && (index === 0 || edit.oldText === edits[index - 1].newText))
    ? [{ ...edits[0], newText: edits.at(-1)!.newText }] : edits
}

export function summarizeChanges(body: ChangesBody) {
  const turn = new Map((body.turnDiff ? parsedPatch(body.turnDiff) ?? [] : []).map(patch => {
    const path = patch.newFileName === '/dev/null' ? patch.oldFileName : patch.newFileName
    return [relativeFile((path ?? '').replace(/^[ab]\//, ''), body.cwd), patch] as const
  }))
  const files = (body.files ?? []).map(file => {
    const patch = turn.get(relativeFile(file.path, body.cwd))
    if (patch) return { file, counts: patchCounts([patch]), patch: formatPatch(patch) }
    const counts = chainedEdits(file.edits).map(editCounts)
    return { file, counts: counts.length > 0 && counts.every(Boolean)
      ? (counts as DiffCounts[]).reduce((sum, count) => ({ added: sum.added + count.added, removed: sum.removed + count.removed }), { added: 0, removed: 0 })
      : undefined, patch: undefined }
  })
  const totals = files.length === body.fileCount && files.every(item => item.counts)
    ? files.reduce((sum, item) => ({ added: sum.added + item.counts!.added, removed: sum.removed + item.counts!.removed }), { added: 0, removed: 0 })
    : undefined
  return { files, totals }
}
