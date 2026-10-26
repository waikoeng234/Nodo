import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { DriverEvent, FileChange, FileChangeEdit, FileChangesBody } from './spi.js'

type RawChanges = { scope?: unknown; coverage?: unknown; files?: unknown; fileCount?: unknown; cwd?: unknown; turnDiff?: unknown }
type RawFile = { path?: unknown; edits?: unknown }
type RawEdit = { operation?: unknown; availability?: unknown; fromPath?: unknown; oldText?: unknown; newText?: unknown; diffText?: unknown }
export interface FileChanges {
  add(id: unknown, files: unknown, confirmed: unknown): void
  diff(text: unknown): void
  snapshot(turnId: string): Extract<DriverEvent, { type: 'changes' }>
}

export const CHANGE_LIMITS = Object.freeze({ files: 512, edits: 1024, bytes: 1024 * 1024 })
const operations: readonly unknown[] = ['add', 'update', 'delete', 'move', 'unknown']
const validPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2000 && !value.includes('\0')
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

export function loadDiff(): typeof import('diff') | undefined {
  try { return createRequire(import.meta.url)('diff') as typeof import('diff') } catch { return undefined }
}

export function replacementEdit(path: string, oldText: string, newText: string): FileChangeEdit {
  if (Buffer.byteLength(oldText) + Buffer.byteLength(newText) > CHANGE_LIMITS.bytes) return { operation: 'update', availability: 'oversized' }
  const diff = loadDiff()
  if (!diff) return { operation: 'update', availability: 'unavailable' }
  const diffText = diff.createPatch(path, oldText, newText, 'Nodo replacement fragment', 'Nodo replacement fragment', { timeout: 40, maxEditLength: 10000 })
  return { operation: 'update', ...(diffText !== undefined ? { diffText } : { availability: 'unavailable' }) }
}

export function textToolChanges(name: string, raw: unknown): { path: string; edit: FileChangeEdit }[] {
  let input = raw
  if (typeof input === 'string') { try { input = JSON.parse(input) } catch { return [] } }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const { file_path: path, content, old_string: oldText, new_string: newText } = input as Record<string, unknown>
  if (typeof path !== 'string' || !['Write', 'Edit'].includes(name)) return []
  const edit: FileChangeEdit = name === 'Edit' && typeof oldText === 'string' && typeof newText === 'string'
    ? replacementEdit(path, oldText, newText)
    : { operation: name === 'Edit' ? 'update' : 'unknown', ...(name === 'Write' && typeof content === 'string' ? { newText: content } : {}) }
  return [{ path, edit }]
}

export function normalizeChanges(value: unknown): { body: FileChangesBody; truncated: boolean } | null {
  if (!(['edit-tools', 'workspace-snapshot'] as readonly unknown[]).includes((value as RawChanges)?.scope) || (value as RawChanges).coverage !== 'partial' || !Array.isArray((value as RawChanges).files)) return null
  const files: FileChange[] = []
  let truncated = ((value as RawChanges).files as unknown[]).length > CHANGE_LIMITS.files
  let edits = 0
  const paths = new Set<string>()
  for (const file of ((value as RawChanges).files as RawFile[]).slice(0, CHANGE_LIMITS.files)) {
    if (!validPath(file?.path) || paths.has(file.path) || !Array.isArray(file.edits)) return null
    paths.add(file.path)
    const changes: FileChangeEdit[] = []
    for (const edit of file.edits as RawEdit[]) {
      if (++edits > CHANGE_LIMITS.edits) { truncated = true; break }
      if (!operations.includes(edit?.operation)) return null
      const clean: FileChangeEdit = { operation: edit.operation as FileChangeEdit['operation'] }
      if (edit.availability !== undefined) {
        if (!(['binary', 'oversized', 'coarse', 'unavailable'] as readonly unknown[]).includes(edit.availability)) return null
        clean.availability = edit.availability as FileChangeEdit['availability']
      }
      if (edit.fromPath !== undefined) { if (!validPath(edit.fromPath)) return null; clean.fromPath = edit.fromPath }
      for (const key of ['oldText', 'newText', 'diffText'] as const) {
        if (edit[key] !== undefined) {
          if (typeof edit[key] !== 'string' && !(key === 'oldText' && edit[key] === null && edit.operation === 'add')) return null
          ;(clean as Record<typeof key, string | null | undefined>)[key] = edit[key] as string | null
        }
      }
      changes.push(clean)
    }
    files.push({ path: file.path, edits: changes })
  }
  const count = Number.isSafeInteger((value as RawChanges).fileCount) && ((value as RawChanges).fileCount as number) >= files.length ? (value as RawChanges).fileCount as number : files.length
  const body: FileChangesBody = { scope: (value as RawChanges).scope as FileChangesBody['scope'], coverage: 'partial', fileCount: count, files,
    ...(validPath((value as RawChanges).cwd) ? { cwd: (value as RawChanges).cwd as string } : {}),
    ...(typeof (value as RawChanges).turnDiff === 'string' ? { turnDiff: (value as RawChanges).turnDiff as string } : {}) }
  if (size(body) > CHANGE_LIMITS.bytes) {
    body.files = files.map(file => ({ path: file.path, edits: file.edits.map(({ operation, fromPath, availability }) => ({ operation, ...(fromPath ? { fromPath } : {}), ...(availability ? { availability } : {}) })) }))
    delete body.turnDiff
    truncated = true
  }
  return { body, truncated }
}

export function createFileChanges(cwd: string | undefined): FileChanges {
  const calls = new Map<unknown, FileChange[]>()
  let truncated = false
  let turnDiff: string | undefined
  let retainedEdits = 0
  return {
    add(id, files, confirmed) {
      if (!id || calls.has(id)) return
      if (calls.size >= CHANGE_LIMITS.edits) { truncated = true; return }
      if (!confirmed) { calls.set(id, []); return }
      if (!Array.isArray(files)) { truncated = true; return }
      const clean: FileChange[] = []
      for (const file of files as { path?: unknown; edit?: unknown }[]) {
        if (retainedEdits >= CHANGE_LIMITS.edits) { truncated = true; break }
        if (!validPath(file?.path)) { truncated = true; continue }
        const path = resolve(cwd!, file.path)
        const normalized = normalizeChanges({ scope: 'edit-tools', coverage: 'partial', files: [{ path, edits: [file.edit] }] })
        if (!normalized) { truncated = true; continue }
        truncated ||= normalized.truncated
        clean.push(normalized.body.files[0])
        retainedEdits += 1
        if (clean.length >= CHANGE_LIMITS.files) { truncated ||= files.length > clean.length; break }
      }
      calls.set(id, clean)
      if (size([...calls.values()]) > CHANGE_LIMITS.bytes) {
        for (const entries of calls.values()) for (const file of entries) file.edits = file.edits.map(({ operation, fromPath }) => ({ operation, ...(fromPath ? { fromPath } : {}) }))
        truncated = true
      }
    },
    diff(text) {
      if (typeof text !== 'string') return
      if (Buffer.byteLength(text) <= CHANGE_LIMITS.bytes / 2) turnDiff = text
      else { turnDiff = undefined; truncated = true }
    },
    snapshot(turnId) {
      const grouped = new Map<string, FileChangeEdit[]>()
      for (const entries of calls.values()) for (const file of entries) {
        if (!grouped.has(file.path) && grouped.size >= CHANGE_LIMITS.files) { truncated = true; continue }
        const edits = grouped.get(file.path) ?? []
        edits.push(...file.edits)
        grouped.set(file.path, edits)
      }
      const normalized = normalizeChanges({ scope: 'edit-tools', coverage: 'partial', files: [...grouped].map(([path, edits]) => ({ path, edits })),
        cwd: resolve(cwd!),
        ...(turnDiff !== undefined ? { turnDiff } : {}) })
      return { type: 'changes', turnId, presentation: { version: 1, kind: 'changes', mode: 'snapshot', body: normalized!.body,
        capture: truncated || normalized!.truncated ? 'partial' : 'complete', ...(truncated || normalized!.truncated ? { reason: 'source-limit' } : {}) } }
    },
  }
}
