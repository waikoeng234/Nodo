import { h, useEffect, useLayoutEffect, useRef, useState, call, CodeBlock, rightPanelService } from './ui-shared.js'
import type { ReactNode } from './ui-shared.js'
import { FileIcon } from './file-icons.tsx'
import type { ToolFileChange } from './tool-file.ts'

// 会话流里悬停弹出的差异/文件/图片预览：固定高度的手动 popover，锚点行上方或
// 下方摆放，滚出、ESC、外点或延迟失焦即关闭。FileChangesSummary、read/write/edit
// 工具行和图片行共用同一套摆放与关闭逻辑；least 是弹层宽度下限（差异要放下
// 代码行，图片贴着缩略图即可）。
export function diffPreviewPosition(row: Pick<DOMRect, 'left' | 'top' | 'bottom' | 'width'>, width: number, height: number,
  bounds: { left?: number; width?: number; top: number; bottom: number } = { top: 0, bottom: height }, least = 720) {
  const previewWidth = Math.max(0, Math.min(Math.max(row.width, least), 1100, width - 24))
  const above = Math.max(0, row.top - Math.max(12, bounds.top + 8) - 8)
  const below = Math.max(0, Math.min(height - 12, bounds.bottom - 8) - row.bottom - 8)
  const onTop = above >= 160 || above >= below
  // 水平居中于会话主栏（传入 bounds 时），否则居中于窗口。
  const span = bounds.width ?? width
  const origin = bounds.width === undefined ? 0 : bounds.left ?? 0
  return { left: `${Math.max(12, Math.min(origin + (span - previewWidth) / 2, width - previewWidth - 12))}px`, width: `${previewWidth}px`,
    top: onTop ? 'auto' : `${row.bottom + 8}px`, bottom: onTop ? `${height - row.top + 8}px` : 'auto',
    maxHeight: `${Math.min(360, onTop ? above : below)}px` }
}

export interface HoverPreviewApi<T> {
  value: T | null
  anchor: { current: HTMLElement | null }
  popup: { current: HTMLDivElement | null }
  show: (value: T, row: HTMLElement) => void
  keep: () => void
  close: () => void
  hide: () => void
}

export function useHoverPreview<T>(): HoverPreviewApi<T> {
  const [value, setValue] = useState<T | null>(null)
  const anchor = useRef<HTMLElement | null>(null)
  const popup = useRef<HTMLDivElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const keep = () => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }
  const close = () => {
    keep()
    timer.current = setTimeout(() => {
      if (!popup.current?.contains(document.activeElement)) setValue(null)
    }, 180)
  }
  const hide = () => { keep(); setValue(null) }
  const show = (next: T, row: HTMLElement) => { keep(); anchor.current = row; setValue(next) }
  return { value, show, keep, close, hide, anchor, popup }
}

export function useHoverPreviewPlacement<T>(preview: HoverPreviewApi<T>, least = 720) {
  useLayoutEffect(() => {
    const popup = preview.popup.current, row = preview.anchor.current
    if (preview.value === null || !popup || !row) return
    const place = () => Object.assign(popup.style, diffPreviewPosition(row.getBoundingClientRect(), window.innerWidth, window.innerHeight,
      row.closest('.nodo-feed')?.getBoundingClientRect(), least))
    popup.popover = 'manual'
    place()
    popup.showPopover?.({ source: row })
    const scroll = (event: Event) => { if (!popup.contains(event.target as Node)) preview.hide() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') preview.hide() }
    const outside = (event: PointerEvent) => { if (!popup.contains(event.target as Node) && !row.contains(event.target as Node)) preview.hide() }
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
  }, [preview.value])
}

export function HoverPreview({ preview, className, id, label, children }: {
  preview: { value: unknown; popup: { current: HTMLDivElement | null }; anchor: { current: HTMLElement | null }; keep: () => void; close: () => void }
  className: string
  id?: string
  label: string
  children: ReactNode
}) {
  if (preview.value === null || preview.value === undefined) return null
  return <div id={id} ref={preview.popup} className={className} role="dialog" tabIndex={-1} aria-label={label}
    onPointerEnter={preview.keep} onPointerLeave={preview.close} onFocusCapture={preview.keep}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget) && !preview.anchor.current?.contains(event.relatedTarget)) preview.close() }}>
    {children}</div>
}

interface LoadedFile { text?: string; image?: { mediaType: string; dataUrl: string }; binary?: boolean; missing?: boolean }

// 读取行的文件预览：实时读工作区文件；读不到（不存在、二进制、越界、失败）
// 就不弹。
export function HoverFilePreview({ preview, scope, path }: {
  preview: { value: unknown; hide: () => void }
  scope?: Record<string, string>
  path: string
}) {
  const [content, setContent] = useState<LoadedFile | null>(null)
  useEffect(() => {
    setContent(null)
    let live = true
    call('workspace-file', { ...scope, path }).then(value => { if (live) setContent(value) })
      .catch(() => { if (live) preview.hide() })
    return () => { live = false }
  }, [preview.value, path])
  useEffect(() => {
    if (content !== null && (content.binary || content.missing)) preview.hide()
  }, [content])
  if (content === null) return <p className="nodo-note">加载中…</p>
  if (content.image) return <img className="nodo-hover-file-image" src={content.image.dataUrl} alt={path} />
  return <CodeBlock code={(content.text ?? '').split('\n', 101).join('\n')} lang={path.split('.').at(-1)?.toLowerCase() ?? ''} wrap showHeader={false} />
}

// read/write/edit 工具行的文件标识：类型图标 + 文件名（点击在右栏打开）+ 灰色
// 目录 + 增删行数；悬停弹出差异或文件预览。
export function ToolFileChip({ file, onShow, onClose, onOpened }: {
  file: ToolFileChange
  onShow: (row: HTMLElement) => void
  onClose: () => void
  onOpened: () => void
}) {
  const target = rightPanelService?.getSnapshot().target
  const open = () => {
    if (!target) return false
    rightPanelService?.openFile(file.path)
    onOpened()
    return true
  }
  return <span className="nodo-tool-call-file" onPointerEnter={event => { if (event.pointerType !== 'touch') onShow(event.currentTarget) }}
      onPointerLeave={onClose}>
    <FileIcon name={file.name} size={14} />
    <span className="nodo-tool-call-file-name" title={file.path} role={target ? 'link' : undefined} tabIndex={target ? 0 : undefined}
      aria-haspopup="dialog" aria-label={`打开 ${file.display}`}
      onClick={event => { if (open() && event.stopPropagation) event.stopPropagation() }}
      onKeyDown={event => { if ((event.key === 'Enter' || event.key === ' ') && open() && event.preventDefault) { event.preventDefault(); event.stopPropagation() } }}
      onFocus={event => onShow(event.currentTarget)} onBlur={onClose}>
      {file.name}
    </span>
    {file.directory !== '' && <span className="nodo-tool-call-directory">{file.directory}</span>}
    {file.counts && <span className="nodo-changes-counts" aria-label={`新增 ${file.counts.added} 行，删除 ${file.counts.removed} 行`}>
      <span className="nodo-changes-added">+{file.counts.added.toLocaleString()}</span>
      <span className="nodo-changes-removed">−{file.counts.removed.toLocaleString()}</span>
    </span>}
  </span>
}

export const HOVER_PREVIEW_CSS = `
.nodo-hover-preview{inset:auto;margin:0;box-sizing:border-box;height:360px;padding:8px 12px;overflow:auto;overscroll-behavior:contain;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-panel);z-index:40}
.nodo-hover-preview .nodo-code-diff{border-radius:var(--dsw-radius-md)}
.nodo-hover-preview .nodo-code-diff:first-child{margin-top:0}
.nodo-hover-preview .nodo-code-diff:last-child{margin-bottom:0}
.nodo-hover-preview .nodo-code-diff-patch{max-height:none}
.nodo-hover-preview::backdrop{background:transparent;pointer-events:none}
.nodo-hover-preview .nodo-note{padding:4px 0}
.nodo-hover-file-image{display:block;max-width:100%;margin:0 auto;border-radius:var(--dsw-radius-md)}
.nodo-hover-preview.nodo-hover-picture{height:auto;padding:8px}
.nodo-hover-picture>img{display:block;max-width:100%;max-height:336px;margin:0 auto;border-radius:var(--dsw-radius-md)}
`
