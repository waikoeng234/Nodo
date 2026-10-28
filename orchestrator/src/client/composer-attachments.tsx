import { h, IconArchiveOutlineRegular, IconBrowseOutlineRegular, IconCheckOutlineRegular, IconPaperclipOutlineRegular } from './ui-shared.js'
import type { ComponentProps } from 'react'

export interface ComposerAttachment {
  name: string
  meta: string
  state: 'uploading' | 'done' | 'error'
  progress?: number
  kind?: 'image' | 'text' | 'archive'
}

const ICONS = { image: IconBrowseOutlineRegular, text: IconPaperclipOutlineRegular, archive: IconArchiveOutlineRegular }

export function composerAttachment(file: { name?: string; mediaType?: string; size?: number }, image = false): ComposerAttachment {
  const name = file.name || (image ? '图片' : '文件')
  const extension = /\.([a-z\d]{1,12})$/i.exec(name)?.[1]?.toUpperCase()
  const kind = image ? 'image' : /^(ZIP|TAR|GZ|TGZ|BZ2|XZ|7Z|RAR)$/.test(extension ?? '') ? 'archive' : 'text'
  const type = image ? '图片' : kind === 'archive' ? '压缩文件' : '文件'
  const size = file.size
  const meta = size !== undefined && Number.isFinite(size) && size >= 0
    ? size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 ** 2).toFixed(1)} MB`
    : [extension ?? (image ? file.mediaType?.split('/')[1]?.toUpperCase() : undefined), type].filter(Boolean).join(' ')
  return { name, meta, kind, state: 'done' }
}

export function ComposerAttachments({ className = '', ...props }: ComponentProps<'div'>) {
  return <div data-slot="composer-attachments" className={`nodo-composer-attachments ${className}`} {...props} />
}

export function ComposerAttachmentChip({ attachment, onRemove, onPreview, disabled, className = '', ...props }:
  Omit<ComponentProps<'div'>, 'children'> & {
    attachment: ComposerAttachment
    onRemove?: (name: string) => void
    onPreview?: () => void
    disabled?: boolean
  }) {
  const Icon = ICONS[attachment.kind ?? 'text']
  const progress = Number.isFinite(attachment.progress) ? Math.max(0, Math.min(100, attachment.progress!)) : 0
  const icon = <Icon size={16} />
  return (
    <div data-slot="composer-attachment" data-state={attachment.state} className={`nodo-composer-attachment ${className}`} {...props}>
      {onPreview ? <button type="button" className="nodo-composer-attachment-icon" aria-label={`预览图片 ${attachment.name}`} onClick={onPreview}>{icon}</button>
        : <span className="nodo-composer-attachment-icon" aria-hidden>{icon}</span>}
      <span className="nodo-composer-attachment-label">
        <span className="nodo-composer-attachment-name" title={attachment.name}>{attachment.name}</span>
        <span className="nodo-composer-attachment-meta">{attachment.meta}</span>
      </span>
      <span className="nodo-composer-attachment-trailing">
        {attachment.state === 'uploading' ? <span className="nodo-composer-attachment-spinner" role="status" aria-label={`正在上传 ${attachment.name}`} />
          : attachment.state === 'done' && onRemove ? <button type="button" className="nodo-composer-attachment-remove" disabled={disabled}
            aria-label={`移除${attachment.kind === 'image' ? '图片' : '文件'} ${attachment.name}`} onClick={() => onRemove(attachment.name)}>×</button>
            : attachment.state === 'done' ? <span className="nodo-composer-attachment-check" aria-label="已添加"><IconCheckOutlineRegular size={14} /></span> : null}
      </span>
      {attachment.state === 'uploading' && <span className="nodo-composer-attachment-progress" role="progressbar" aria-label={`上传 ${attachment.name}`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} style={{ width: `${progress}%` }} />}
    </div>
  )
}

export const COMPOSER_ATTACHMENTS_CSS = `
.nodo-composer-attachments{display:flex;flex-wrap:wrap;gap:8px;max-height:144px;overflow:auto;padding:0 12px}
.nodo-composer-attachment{position:relative;display:flex;align-items:center;gap:8px;max-width:100%;min-width:0;padding:6px 12px 6px 6px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.nodo-composer-attachment-icon{display:flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;padding:0;border:0;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
button.nodo-composer-attachment-icon{cursor:zoom-in}
.nodo-composer-attachment-label{display:flex;flex-direction:column;min-width:0}
.nodo-composer-attachment-name{max-width:144px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:500;line-height:18px}
.nodo-composer-attachment-meta{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.nodo-composer-attachment[data-state=error] .nodo-composer-attachment-meta{color:var(--dsw-alias-state-error-primary)}
.nodo-composer-attachment-trailing{display:flex;align-items:center;justify-content:flex-end;flex:none;width:20px;margin-left:4px}
.nodo-composer-attachment-remove{display:flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:16px;cursor:pointer}
.nodo-composer-attachment-remove:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.nodo-composer-attachment-remove:disabled{opacity:.5;cursor:default}
.nodo-composer-attachment-icon:focus-visible,.nodo-composer-attachment-remove:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.nodo-composer-attachment-check{display:flex;color:var(--dsw-alias-state-success-primary)}
.nodo-composer-attachment-spinner{width:14px;height:14px;border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;animation:nodo-attachment-spin .8s linear infinite}
.nodo-composer-attachment-progress{position:absolute;bottom:0;left:0;height:2px;background:var(--dsw-alias-state-business-primary);transition:width .3s}
@keyframes nodo-attachment-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.nodo-composer-attachment-spinner{animation:none}.nodo-composer-attachment-progress{transition:none}}
`
