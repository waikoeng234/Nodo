import { chainedEdits, editCounts, relativeFile } from './file-diffs.ts'
import type { DiffCounts, FileEdit } from './file-diffs.ts'

// 工具行里的单个文件改动：oldText/newText 是编辑前后内容，patch 是补丁文本。
export interface ToolFileDiff { path: string; oldText?: string | null; newText?: string; patch?: string }
export interface ToolFileChange {
  path: string
  display: string
  name: string
  directory: string
  counts?: DiffCounts
  diffs: ToolFileDiff[]
}

const PATH_KEYS = ['file_path', 'filePath', 'path']

const parseJson = (input: unknown): unknown => {
  if (typeof input === 'string' && input.trimStart().startsWith('{')) {
    try { return JSON.parse(input) } catch { return input }
  }
  return input
}

// 各引擎入参：claude/qoder/zcode 直接给字段；acp 系（opencode/codebuddy）包在
// rawInput 里；codex 的 fileChange 只给 changes 补丁数组（或裸数组）。
const unwrap = (input: unknown): Record<string, unknown> | null => {
  let value = parseJson(input)
  if (Array.isArray(value)) return { changes: value }
  if (!value || typeof value !== 'object') return null
  let record = value as Record<string, unknown>
  if (record.rawInput !== undefined) {
    const raw = parseJson(record.rawInput)
    if (Array.isArray(raw)) return { changes: raw }
    if (!raw || typeof raw !== 'object') return null
    record = raw as Record<string, unknown>
  }
  return record
}

const textField = (args: Record<string, unknown>, keys: readonly string[]) =>
  keys.map(key => args[key]).find(value => typeof value === 'string' && value.trim() !== '') as string | undefined

const editDiffs = (args: Record<string, unknown>, path: string): ToolFileDiff[] | null => {
  const list = Array.isArray(args.edits) ? args.edits : []
  if (list.length > 0 && list.every(item => item && typeof item === 'object'
      && typeof (item as Record<string, unknown>).oldText === 'string' && typeof (item as Record<string, unknown>).newText === 'string'))
    return list.map(item => ({ path, oldText: (item as Record<string, unknown>).oldText as string, newText: (item as Record<string, unknown>).newText as string }))
  const oldText = textField(args, ['oldText', 'old_string'])
  const newText = textField(args, ['newText', 'new_string'])
  return typeof oldText === 'string' && typeof newText === 'string' ? [{ path, oldText, newText }] : null
}

const lastSegment = (path: string) => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

function describe(path: string, diffs: ToolFileDiff[], cwd?: string): ToolFileChange {
  const display = relativeFile(path, cwd)
  const name = lastSegment(display)
  const counts = diffs.length === 0 ? undefined
    : chainedEdits(diffs.map(diff => ({ operation: diff.oldText == null ? 'add' : 'update',
      oldText: diff.oldText ?? null, newText: diff.newText, diffText: diff.patch }) satisfies FileEdit))
      .reduce<DiffCounts | undefined>((sum, edit) => {
        const count = editCounts(edit)
        return sum && count ? { added: sum.added + count.added, removed: sum.removed + count.removed } : undefined
      }, { added: 0, removed: 0 })
  return { path, display, name, directory: display.slice(0, display.length - name.length), counts, diffs }
}

// 资源引用解析为工作区文件引用：file: URI 还原成路径；绝对路径须落在 cwd 内，
// 相对路径交给 workspace-file 端点自行限定；远程地址、~ 与越界路径返回 null。
export function referenceFile(uri: unknown, cwd?: string): ToolFileChange | null {
  if (typeof uri !== 'string' || uri.trim() === '' || uri.startsWith('~')) return null
  let path = uri
  if (/^[a-z][\w+.-]*:/i.test(uri)) {
    if (!/^file:/i.test(uri)) return null
    try { path = decodeURIComponent(new URL(uri).pathname) } catch { return null }
  } else if (uri.startsWith('//')) return null
  if (path.startsWith('/') && (cwd === undefined || !(path === cwd || path.startsWith(`${cwd}/`)))) return null
  return path !== '/' && lastSegment(path) !== '' ? describe(path, [], cwd) : null
}

// 从工具入参还原 read/write/edit 行的文件与差异；还原不出路径时返回 null，
// 行保持原样。diffs 为空的行没有 per-call 差异（如 dsh），悬停退化为文件预览。
export function toolFileChange(input: unknown, cwd?: string): ToolFileChange | null {
  const args = unwrap(input)
  if (args === null) {
    // 读取类工具常把路径作为纯字符串入参传入；截断的 JSON 等伪路径要拒收。
    const bare = typeof input === 'string' ? input.trim() : ''
    return bare !== '' && !/\s/.test(bare) && !/[\\/]$/.test(bare) && !/["{}]/.test(bare)
      && (!bare.includes(':') || /^[a-zA-Z]:[\\/]/.test(bare))
      && lastSegment(bare).includes('.')
      ? describe(bare, [], cwd) : null
  }
  const patches = (Array.isArray(args.changes) ? args.changes : []).flatMap(change => {
    const item = change && typeof change === 'object' ? change as Record<string, unknown> : null
    return item && typeof item.path === 'string' && typeof item.diff === 'string' ? [{ path: item.path, patch: item.diff }] : []
  })
  if (patches.length > 0) return describe(patches[0].path, patches, cwd)
  const path = textField(args, PATH_KEYS)
  if (path === undefined) return null
  const edits = editDiffs(args, path)
  if (edits !== null) return describe(path, edits, cwd)
  const content = textField(args, ['content'])
  return describe(path, content === undefined ? [] : [{ path, oldText: null, newText: content }], cwd)
}
