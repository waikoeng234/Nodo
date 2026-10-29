import { h, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, IconCodeOutlineRegular, IconChevronDownOutlineRegular, rightPanelService } from './ui-shared.js'
import type { ReactNode } from './ui-shared.js'
import { CodeDiff } from './code-diff.tsx'
import { relativeFile, summarizeChanges } from './file-diffs.ts'
import type { ChangedFileData, ChangesBody, DiffCounts } from './file-diffs.ts'
import { buildFileTree, FileTree, FILE_TREE_CSS } from './file-tree.tsx'

const subscribePanel = (listener: () => void) => rightPanelService?.subscribe(listener) ?? (() => {})
const panelTarget = () => rightPanelService?.getSnapshot().target ?? null

interface ChangeRecord {
  runId: string
  entityId: string
  revision: number
  body: ChangesBody
  capture?: string
  truncated?: boolean
}
interface FileChangesSummaryProps {
  record: ChangeRecord
  value: ChangeRecord
  full: unknown
  busy?: boolean
  available?: unknown
  error?: string
  load: () => Promise<ChangeRecord | null | void>
  loadChanges?: () => Promise<ChangeRecord | null | void>
  renderFile: (file: ChangedFileData, patch?: string, panel?: boolean, preview?: boolean) => ReactNode
}

export function Counts({ value }: { value?: DiffCounts }) {
  return value ? <span className="nodo-changes-counts" aria-label={`新增 ${value.added} 行，删除 ${value.removed} 行`}>
    <span className="nodo-changes-added">+{value.added.toLocaleString()}</span>
    <span className="nodo-changes-removed">−{value.removed.toLocaleString()}</span>
  </span> : null
}

export function diffPreviewPosition(row: Pick<DOMRect, 'left' | 'top' | 'bottom' | 'width'>, width: number, height: number, bounds = { top: 0, bottom: height }) {
  const previewWidth = Math.max(0, Math.min(Math.max(row.width, 720), 1100, width - 24))
  const above = Math.max(0, row.top - Math.max(12, bounds.top + 8) - 8)
  const below = Math.max(0, Math.min(height - 12, bounds.bottom - 8) - row.bottom - 8)
  const onTop = above >= 160 || above >= below
  return { left: `${Math.max(12, Math.min(row.left, width - previewWidth - 12))}px`, width: `${previewWidth}px`,
    top: onTop ? 'auto' : `${row.bottom + 8}px`, bottom: onTop ? `${height - row.top + 8}px` : 'auto',
    maxHeight: `${Math.min(360, onTop ? above : below)}px` }
}

export function FileChangesSummary({ record, value, full, load, loadChanges = load, busy = false, available, error, renderFile }: FileChangesSummaryProps) {
  const [expanded, setExpanded] = useState(false)
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const target = useSyncExternalStore(subscribePanel, panelTarget)
  const box = useRef<HTMLDivElement>(null)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const preview = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const detailsId = `nodo-changes-${useId()}`
  const previewId = `${detailsId}-preview`
  const { files, totals } = useMemo(() => summarizeChanges(value.body), [value.body])
  const byPath = new Map(files.map((entry, index) => [entry.file.path, { ...entry, index }]))
  const tree = buildFileTree((expanded ? files : files.slice(0, 3)).map(({ file, counts }) => ({
    path: file.path, relativePath: relativeFile(file.path, value.body.cwd), additions: counts?.added, deletions: counts?.removed,
  })))
  const count = record.body.fileCount
  const workspace = record.body.scope === 'workspace-snapshot'
  const canLoad = Boolean(available) && !full
  const keepPreview = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const closePreview = () => {
    keepPreview()
    closeTimer.current = setTimeout(() => {
      if (!preview.current?.contains(document.activeElement)) setSelected(null)
    }, 180)
  }
  useEffect(() => {
    setExpanded(false); setOpen(false); setSelected(null)
    return keepPreview
  }, [record.runId, record.entityId, record.revision])
  useEffect(() => {
    if (!canLoad || !record.truncated || !count) return
    if (typeof IntersectionObserver === 'undefined') { void load(); return }
    let requested = false
    const observer = new IntersectionObserver(entries => {
      if (requested || !entries.some(entry => entry.isIntersecting)) return
      requested = true
      observer.disconnect()
      void load()
    }, { rootMargin: '200px' })
    if (box.current) observer.observe(box.current)
    return () => { requested = true; observer.disconnect() }
  }, [record.runId, record.entityId, record.revision, canLoad])
  useLayoutEffect(() => {
    const popup = preview.current, row = anchor.current
    if (selected === null || !popup || !row) return
    const place = () => Object.assign(popup.style, diffPreviewPosition(row.getBoundingClientRect(), window.innerWidth, window.innerHeight,
      row.closest('.nodo-feed')?.getBoundingClientRect()))
    popup.popover = 'manual'
    place()
    popup.showPopover?.({ source: row })
    const scroll = (event: Event) => { if (!popup.contains(event.target as Node)) setSelected(null) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelected(null) }
    const outside = (event: PointerEvent) => { if (!popup.contains(event.target as Node) && !row.contains(event.target as Node)) setSelected(null) }
    window.addEventListener('resize', place)
    window.addEventListener('scroll', scroll, true)
    document.addEventListener('keydown', escape)
    document.addEventListener('pointerdown', outside)
    return () => {
      if (popup.hidePopover && popup.matches(':popover-open')) popup.hidePopover()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', scroll, true)
      document.removeEventListener('keydown', escape)
      document.removeEventListener('pointerdown', outside)
    }
  }, [selected])
  const showFile = (path: string, row: HTMLButtonElement) => {
    keepPreview()
    anchor.current = row
    setSelected(path)
    if (canLoad && record.truncated && !busy) void load()
  }
  const showAll = async () => {
    keepPreview(); setSelected(null)
    if (target) { openChanges(); return }
    if (open) { setOpen(false); return }
    if (canLoad && record.truncated && !await load()) return
    setExpanded(true)
    setOpen(true)
  }
  const openChanges = (path?: string) => rightPanelService?.openChanges({ body: value.body, revision: record.revision, renderFile,
    load: canLoad && (record.truncated || files.length < count) ? async () => {
      const loaded = await loadChanges()
      if (!loaded) throw new Error('变更详情读取失败')
      return loaded.body
    } : undefined }, path)
  const more = async () => {
    if (!expanded && files.length < count && canLoad && !await load()) return
    if (expanded && selected !== null && files.findIndex(({ file }) => file.path === selected) >= 3) setSelected(null)
    setExpanded(current => !current)
  }
  const selectedFile = files.find(({ file }) => file.path === selected)
  return <div className="nodo-changes-card" ref={box} data-nodo-changes-summary="">
    <div className="nodo-changes-header">
      <span className="nodo-changes-icon" aria-hidden><IconCodeOutlineRegular size={22} /></span>
      <div className="nodo-changes-heading">
        <div className="nodo-changes-title">{workspace ? '工作区变更' : '已编辑'} {count} 个文件
          <span className="nodo-changes-coverage" title={workspace
            ? '宿主工作区快照，可能包含其他会话或进程的修改。'
            : '仅包含来源确认的编辑记录，可能不完整；没有轮次差异时，数字按已保存的编辑记录统计。'}>{workspace ? '工作区' : '部分记录'}</span>
        </div>
        <Counts value={totals} />
      </div>
      <button type="button" className="nodo-changes-view" disabled={busy} aria-expanded={target ? undefined : open}
        aria-controls={target ? undefined : detailsId} onClick={() => showAll()}>{busy ? '加载中…' : !target && open ? '收起变更' : '查看变更'}</button>
    </div>
    <FileTree id={detailsId} className="nodo-changes-files" nodes={tree} header={false} renderFile={(node, content) => {
        const { file, patch, index } = byPath.get(node.path)!
        const fileDetailsId = `${detailsId}-${index}`
        return <div key={file.path} className="nodo-changes-file-entry">
          <button type="button" className="nodo-changes-file" disabled={busy} aria-expanded={target ? undefined : open || selected === file.path}
            aria-label={target ? `查看 ${relativeFile(file.path, value.body.cwd)} 的变更` : undefined}
            aria-haspopup="dialog" aria-controls={target ? undefined : open ? fileDetailsId : previewId}
            onPointerEnter={event => { if (!open && event.pointerType !== 'touch') showFile(file.path, event.currentTarget) }}
            onPointerLeave={closePreview} onFocus={event => { if (!open) showFile(file.path, event.currentTarget) }}
            onBlur={event => { if (!preview.current?.contains(event.relatedTarget)) closePreview() }}
            onClick={event => { if (target) { closePreview(); openChanges(file.path); return } setOpen(false); showFile(file.path, event.currentTarget) }}>
            {content}
          </button>
          {open && <div id={fileDetailsId} className="nodo-changes-details" role="region" aria-label={`${relativeFile(file.path, value.body.cwd)} 变更详情`}>
            {renderFile(file, patch)}
          </div>}
        </div>
      }} />
    {count > 3 && <button type="button" className="nodo-changes-more" disabled={busy || !expanded && files.length <= 3 && !canLoad}
      aria-expanded={expanded} onClick={() => more()}>{expanded ? '收起文件列表' : `再显示 ${count - 3} 个文件`}
      <IconChevronDownOutlineRegular size={14} style={expanded ? { transform: 'rotate(180deg)' } : undefined} /></button>}
    {files.length < count && !canLoad && <div className="nodo-changes-notice">仅保存 {files.length} / {count} 个文件</div>}
    {error && <div className="nodo-changes-notice" role="alert">{error}</div>}
    {selectedFile && <div id={previewId} ref={preview} className="nodo-changes-preview" role="dialog" tabIndex={-1}
      aria-label={`${relativeFile(selectedFile.file.path, value.body.cwd)} 变更预览`}
      onPointerEnter={keepPreview} onPointerLeave={closePreview} onFocusCapture={keepPreview}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget) && !anchor.current?.contains(event.relatedTarget)) closePreview() }}>
      {busy && canLoad ? <div className="nodo-changes-notice" role="status">加载中…</div>
        : error ? <div className="nodo-changes-notice" role="alert">{error}</div>
          : renderFile(selectedFile.file, selectedFile.patch, false, true)}
    </div>}
    {open && files.length === 0 && value.body.turnDiff && <div className="nodo-changes-details" role="region" aria-label="文件变更详情">
      <CodeDiff filename="轮次差异" previewable={false} patch={value.body.turnDiff} cycle={record.revision} />
    </div>}
  </div>
}

export const FILE_CHANGES_SUMMARY_CSS = FILE_TREE_CSS + `
.nodo-changes-card{min-width:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xl);overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.nodo-changes-header{display:flex;align-items:center;gap:12px;min-width:0;padding:12px 16px}
.nodo-changes-icon{display:flex;align-items:center;justify-content:center;flex:none;width:40px;height:40px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.nodo-changes-heading{flex:1;min-width:0}
.nodo-changes-title{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:var(--dsh-content-font-size,14px);font-weight:600;line-height:24px}
.nodo-changes-coverage{font-size:12px;line-height:18px;font-weight:400;color:var(--dsw-alias-label-tertiary)}
.nodo-changes-counts{display:inline-flex;flex:none;gap:6px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;font-variant-numeric:tabular-nums;white-space:nowrap}
.nodo-changes-added{color:var(--dsw-alias-state-success-primary)}
.nodo-changes-removed{color:var(--dsw-alias-state-error-primary)}
.nodo-changes-view{flex:none;padding:5px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-base);color:inherit;font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;font-weight:500;cursor:pointer}
.nodo-changes-files{border-top:.5px solid var(--dsw-alias-border-l1)}
.nodo-changes-file-entry{min-width:0}
.nodo-changes-file{display:block;min-width:0;width:100%;padding:0;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;text-align:left;cursor:pointer}
.nodo-changes-more{display:flex;align-items:center;gap:8px;width:100%;padding:12px 16px;border:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;text-align:left;cursor:pointer}
.nodo-changes-view:hover:not(:disabled),.nodo-changes-file:hover:not(:disabled),.nodo-changes-more:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-changes-card button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.nodo-changes-card button:disabled{opacity:.5;cursor:default}
.nodo-changes-notice{padding:6px 16px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.nodo-changes-notice[role=alert]{color:var(--dsw-alias-state-error-primary)}
.nodo-changes-details{min-width:0;border-top:.5px solid var(--dsw-alias-border-l1);padding:8px 12px 12px}
.nodo-changes-details .nodo-code-diff{border-radius:var(--dsw-radius-md)}
.nodo-changes-preview{inset:auto;margin:0;box-sizing:border-box;height:360px;padding:8px 12px;overflow:auto;overscroll-behavior:contain;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-panel);z-index:40}
.nodo-changes-preview .nodo-code-diff{border-radius:var(--dsw-radius-md)}
.nodo-changes-preview .nodo-code-diff-patch{max-height:none}
.nodo-file-view-header{position:sticky;top:-8px;z-index:1;display:flex;align-items:center;gap:8px;padding:8px 0;background:var(--dsw-alias-bg-base)}
.nodo-file-view-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-secondary)}
.nodo-changes-preview::backdrop{background:transparent;pointer-events:none}
@media(max-width:420px){.nodo-changes-header{gap:8px;padding:12px}.nodo-changes-icon{width:32px;height:32px}.nodo-changes-coverage{display:none}}
`
