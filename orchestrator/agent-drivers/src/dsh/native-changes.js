import { resolve } from 'node:path'
import { CHANGE_LIMITS, normalizeChanges } from '../file-changes.js'

export function nativeDshChanges(host, sessionId, seq, turn, turnId) {
  let service, summary
  try { service = host.get?.('workspaceChanges'); summary = service?.summary?.(sessionId, seq) } catch {}
  if (!summary || summary.turn !== turn || typeof summary.cwd !== 'string' || !Array.isArray(summary.files)) return null
  const files = summary.files.slice(0, CHANGE_LIMITS.files).map((file, index) => ({ file, index }))
    .filter(({ file }) => typeof file?.path === 'string' && file.path.length > 0)
    .map(({ file, index }) => ({ path: resolve(summary.cwd, file.path), index, edit: { operation: 'unknown', availability: file.binary ? 'binary' : file.oversized ? 'oversized' : 'unavailable' } }))
  const signal = AbortSignal.timeout(2000)
  const timeout = new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  let next = 0
  let bytes = 0
  let limited = false
  return Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
    while (next < files.length && !signal.aborted) {
      const file = files[next++]
      if (file.edit.availability !== 'unavailable' || typeof service.diff !== 'function') continue
      try {
        const diff = await Promise.race([service.diff(sessionId, seq, file.index, signal), timeout])
        if (!diff || resolve(summary.cwd, diff.path) !== file.path) continue
        if (['binary', 'oversized'].includes(diff.kind)) file.edit.availability = diff.kind
        else if (diff.kind === 'text' && Array.isArray(diff.hunks) && diff.hunks.every(hunk => hunk && ['oldStart', 'oldLines', 'newStart', 'newLines'].every(key => Number.isSafeInteger(hunk[key]) && hunk[key] >= 0)
          && Array.isArray(hunk.lines) && hunk.lines.every(line => typeof line === 'string'))) {
          const text = diff.hunks.map(hunk => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}`).join('\n')
          bytes += Buffer.byteLength(text)
          if (bytes > CHANGE_LIMITS.bytes / 2) { limited = true; continue }
          file.edit.diffText = text
          if (diff.coarse) file.edit.availability = 'coarse'
          else delete file.edit.availability
        }
      } catch {}
    }
  })).then(() => {
    const normalized = normalizeChanges({ scope: 'workspace-snapshot', coverage: 'partial', cwd: summary.cwd, fileCount: summary.total,
      files: files.map(file => ({ path: file.path, edits: [file.edit] })) })
    if (!normalized) return null
    const truncated = limited || normalized.truncated || summary.total > files.length
    return { type: 'changes', turnId, presentation: { version: 1, kind: 'changes', mode: 'snapshot', body: normalized.body,
      capture: truncated ? 'partial' : 'complete', ...(truncated ? { reason: 'source-limit' } : {}) } }
  })
}
