import { h, useEffect, useId, useState, IconCheckOutlineRegular, IconChevronRightOutlineRegular } from './ui-shared.js'
import type { ReactNode } from './ui-shared.js'

export type ToolCallStatus = 'started' | 'running' | 'done' | 'error' | 'denied' | 'interrupted' | 'unknown'
export interface ToolCallProps {
  label: string
  activeLabel?: string
  query?: string
  queryNode?: ReactNode
  after?: ReactNode
  status?: ToolCallStatus
  compact?: boolean
  expandable?: boolean
  kind?: 'tool' | 'thinking' | 'plan'
  open: boolean
  onOpenChange: (open: boolean) => void
  children?: ReactNode
}

const STATUS_LABELS: Record<ToolCallStatus, string> = {
  started: '已发起', running: '运行中', done: '已完成', error: '失败', denied: '已拒绝', interrupted: '已停止', unknown: '结果未确认',
}
const COLLAPSE_MS = 200

export function toolCallQuery(input: unknown, fallback = ''): string {
  if (typeof input === 'string' && input.trimStart().startsWith('{')) {
    try { return toolCallQuery(JSON.parse(input), fallback) } catch {}
  }
  if (input && typeof input === 'object') {
    const args = input as Record<string, unknown>
    input = ['command', 'cmd', 'query', 'pattern', 'file_path', 'filePath', 'path', 'url', 'uri', 'description', 'title']
      .map(key => args[key]).find(value => typeof value === 'string' && value.trim() !== '')
  }
  return (typeof input === 'string' && input.trim() ? input : fallback).trim().split(/\r?\n/, 1)[0].slice(0, 400)
}

export function ToolCall({ label, activeLabel = label, query = '', queryNode, after, status = 'unknown', compact = false, expandable = true, kind = 'tool', open, onOpenChange, children }: ToolCallProps) {
  const id = `nodo-tool-${useId()}`
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) { setMounted(true); return }
    if (!mounted) return
    const timer = setTimeout(() => setMounted(false), COLLAPSE_MS)
    return () => clearTimeout(timer)
  }, [open, mounted])
  const running = status === 'running'
  const statusLabel = kind === 'tool' ? `：${STATUS_LABELS[status]}` : running ? '：进行中' : ''
  const chevron = <span className="nodo-tool-call-chevron" aria-hidden><IconChevronRightOutlineRegular size={14} /></span>
  return (
    <div className="nodo-tool-call" data-open={open} data-state={status} data-compact={compact} data-kind={kind}>
      <button type="button" className="nodo-tool-call-trigger" {...(expandable ? { 'aria-expanded': open, 'aria-controls': id } : {})}
        aria-label={`${running ? activeLabel : label}${query ? ` ${query}` : ''}${statusLabel}`} onClick={() => onOpenChange(!open)}>
        {!compact && expandable && chevron}
        <span className="nodo-tool-call-label">{running ? activeLabel : label}</span>
        {queryNode !== undefined ? queryNode : query !== '' && <span className="nodo-tool-call-query" title={query}>{query}</span>}
        {kind === 'tool' && (!compact || !['done', 'running', 'started'].includes(status)) && <span className="nodo-tool-call-status" aria-hidden title={STATUS_LABELS[status]}>
          {compact ? STATUS_LABELS[status] : status === 'done' ? <IconCheckOutlineRegular size={14} /> : running || status === 'started' ? null : status === 'interrupted' ? '−' : status === 'unknown' ? '?' : '!'}
        </span>}
        {compact && expandable && chevron}
      </button>
      <div id={id} className="nodo-tool-call-panel" aria-hidden={!open} {...(!open ? { inert: '' } : {})}>
        <div className="nodo-tool-call-clip"><div className="nodo-tool-call-content">{(open || mounted) && children}</div></div>
      </div>
      {after}
    </div>
  )
}

export const TOOL_CALL_CSS = `
.nodo-tool-call{min-width:0}
.nodo-tool-call-trigger{display:flex;align-items:center;gap:8px;width:100%;min-width:0;min-height:28px;padding:2px 0;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));text-align:left;cursor:pointer}
.nodo-tool-call-trigger:hover{color:var(--dsw-alias-label-primary)}
.nodo-tool-call-trigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.nodo-tool-call-chevron{display:flex;flex:none;transition:transform ${COLLAPSE_MS}ms ease}
.nodo-tool-call[data-open=true] .nodo-tool-call-chevron{transform:rotate(90deg)}
.nodo-tool-call-label{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-tool-call[data-state=running] .nodo-tool-call-label{color:transparent;background:linear-gradient(100deg,var(--dsw-alias-label-tertiary) 35%,var(--dsw-alias-label-primary) 50%,var(--dsw-alias-label-tertiary) 65%);background-size:250% 100%;background-clip:text;animation:nodo-tool-call-shimmer 1.8s linear infinite}
.nodo-tool-call-query{flex:0 1 auto;min-width:0;max-width:55%;padding:0 6px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-markdown-code-block-small);line-height:20px;text-overflow:ellipsis;white-space:nowrap}
.nodo-tool-call-file{display:inline-flex;align-items:center;gap:6px;flex:0 1 auto;min-width:0;max-width:55%}
.nodo-tool-call-file-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-tool-call-file-name[role=link]{cursor:pointer}
.nodo-tool-call-file-name[role=link]:hover{text-decoration:underline}
.nodo-tool-call-file-name[role=link]:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:var(--dsw-radius-sm)}
.nodo-tool-call-directory{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.nodo-tool-call-file .nodo-changes-counts{font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px}
.nodo-tool-call-status{display:flex;align-items:center;justify-content:center;flex:none;width:14px;height:20px;color:var(--dsw-alias-label-tertiary)}
.nodo-tool-call[data-state=error] .nodo-tool-call-status,.nodo-tool-call[data-state=denied] .nodo-tool-call-status{color:var(--dsw-alias-state-error-primary)}
.nodo-tool-call-panel{display:grid;grid-template-rows:0fr;opacity:0;visibility:hidden;transition:grid-template-rows ${COLLAPSE_MS}ms ease,opacity ${COLLAPSE_MS}ms ease,visibility ${COLLAPSE_MS}ms}
.nodo-tool-call[data-open=true] .nodo-tool-call-panel{grid-template-rows:1fr;opacity:1;visibility:visible}
.nodo-tool-call-clip{min-height:0;overflow:hidden}
.nodo-tool-call-content{min-width:0;padding:4px 0 6px 22px}
.nodo-tool-call-content>.nodo-io-card{margin:0}
.nodo-tool-call-content .nodo-io-section+.nodo-io-section{border-top:.5px solid var(--dsw-alias-border-l1)}
.nodo-tool-call[data-compact=true] .nodo-tool-call-trigger{min-height:32px;gap:8px}
.nodo-tool-call[data-compact=true] .nodo-tool-call-label{flex:none;max-width:40%}
.nodo-tool-call[data-compact=true] .nodo-tool-call-query{max-width:min(65%,48ch);padding:2px 8px;border:0;border-radius:8px;line-height:22px;color:var(--dsw-alias-label-secondary)}
.nodo-tool-call[data-compact=true] .nodo-tool-call-file{max-width:min(65%,52ch)}
.nodo-tool-call[data-compact=true]:not([data-kind=tool]) .nodo-tool-call-query{max-width:min(65%,52ch);font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:22px}
.nodo-tool-call[data-compact=true] .nodo-tool-call-chevron{opacity:.35}
.nodo-tool-call[data-compact=true]:hover .nodo-tool-call-chevron,.nodo-tool-call[data-compact=true]:focus-within .nodo-tool-call-chevron,.nodo-tool-call[data-compact=true][data-open=true] .nodo-tool-call-chevron{opacity:1}
.nodo-tool-call[data-compact=true] .nodo-tool-call-status{width:auto;white-space:nowrap;font-size:var(--dsh-content-font-size-tertiary,12px)}
.nodo-tool-call[data-compact=true] .nodo-tool-call-content{margin:4px 0 8px;padding:4px 0 4px 12px;border-left:1px solid var(--dsw-alias-border-l1)}
@keyframes nodo-tool-call-shimmer{from{background-position:150% 0}to{background-position:-150% 0}}
@media(prefers-reduced-motion:reduce){.nodo-tool-call-chevron,.nodo-tool-call-panel{transition:none}.nodo-tool-call[data-state=running] .nodo-tool-call-label{animation:none;background:none;color:var(--dsw-alias-label-secondary)}}
`
