import { h, useEffect, useId, useState, IconChevronRightOutlineRegular } from './ui-shared.js'
import type { ReactNode } from './ui-shared.js'

export interface TimelineStep {
  id: string
  icon: ReactNode
  content: ReactNode
  active?: boolean
  depth?: number
  callId?: string
  parentCallId?: string
}
export interface ToolTimelineProps {
  steps: readonly TimelineStep[]
  summary: string
  streaming?: boolean
}

const COLLAPSE_MS = 200

export function ToolTimeline({ steps, summary, streaming = false }: ToolTimelineProps) {
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const id = `nodo-timeline-${useId()}`
  useEffect(() => {
    if (open) { setMounted(true); return }
    if (!mounted) return
    const timer = setTimeout(() => setMounted(false), COLLAPSE_MS)
    return () => clearTimeout(timer)
  }, [open, mounted])
  if (steps.length === 0) return null
  return (
    <div className="nodo-tool-timeline" data-flow="process" data-open={open} data-streaming={streaming}>
      <button type="button" className="nodo-tool-timeline-trigger" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
        <span className="nodo-tool-timeline-chevron" aria-hidden><IconChevronRightOutlineRegular size={14} /></span>
        <span className="nodo-tool-timeline-label">{streaming ? '正在处理' : `${steps.length} 个步骤`}</span>
        <span className="nodo-tool-timeline-summary">{summary}</span>
      </button>
      <div id={id} className="nodo-tool-timeline-panel" aria-hidden={!open} {...(!open ? { inert: '' } : {})}>
        <div className="nodo-tool-timeline-clip">
          {(open || mounted) && <div className="nodo-tool-timeline-content">
            <ol className="nodo-tool-timeline-steps">
              {steps.map(step => <li key={step.id} className="nodo-tool-timeline-step" data-active={streaming && step.active === true}
                data-call-id={step.callId} data-parent-call-id={step.parentCallId} data-nodo-depth={step.depth || undefined}
                style={step.depth ? { marginLeft: `${step.depth * 16}px` } : undefined}>
                <span className="nodo-tool-timeline-icon" aria-hidden>{step.icon}</span>
                <div className="nodo-tool-timeline-detail">{step.content}</div>
              </li>)}
            </ol>
          </div>}
        </div>
      </div>
    </div>
  )
}

export const TOOL_TIMELINE_CSS = `
.nodo-tool-timeline{min-width:0}
.nodo-tool-timeline-trigger{display:flex;align-items:center;gap:8px;max-width:100%;min-height:28px;padding:2px 0;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));text-align:left;cursor:pointer}
.nodo-tool-timeline-trigger:hover{color:var(--dsw-alias-label-primary)}
.nodo-tool-timeline-trigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.nodo-tool-timeline-chevron{display:flex;flex:none}
.nodo-tool-timeline-chevron{transition:transform ${COLLAPSE_MS}ms ease}
.nodo-tool-timeline[data-open=true] .nodo-tool-timeline-chevron{transform:rotate(90deg)}
.nodo-tool-timeline-label{flex:none}
.nodo-tool-timeline-summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.nodo-tool-timeline-summary:not(:empty)::before{content:'·';margin-right:8px}
.nodo-tool-timeline[data-streaming=true] .nodo-tool-timeline-label{color:transparent;background:linear-gradient(100deg,var(--dsw-alias-label-tertiary) 35%,var(--dsw-alias-label-primary) 50%,var(--dsw-alias-label-tertiary) 65%);background-size:250% 100%;background-clip:text;animation:nodo-timeline-shimmer 1.8s linear infinite}
.nodo-tool-timeline-step[data-active=true]>.nodo-tool-timeline-icon{color:var(--dsw-alias-label-primary);animation:nodo-timeline-pulse 1.8s ease-in-out infinite}
.nodo-tool-timeline-panel{display:grid;grid-template-rows:0fr;opacity:0;visibility:hidden;transition:grid-template-rows ${COLLAPSE_MS}ms ease,opacity ${COLLAPSE_MS}ms ease,visibility ${COLLAPSE_MS}ms}
.nodo-tool-timeline[data-open=true] .nodo-tool-timeline-panel{grid-template-rows:1fr;opacity:1;visibility:visible}
.nodo-tool-timeline-clip{min-height:0;overflow:hidden}
.nodo-tool-timeline-content{padding:8px 0 6px 22px;min-width:0}
.nodo-tool-timeline-steps{list-style:none;margin:0;padding:0}
.nodo-tool-timeline-step{position:relative;display:grid;grid-template-columns:16px minmax(0,1fr);gap:10px;min-width:0;padding:0 0 4px;animation:nodo-timeline-enter 200ms ease-out}
.nodo-tool-timeline-step:last-child{padding-bottom:0}
.nodo-tool-timeline-icon{display:flex;align-items:center;justify-content:center;height:32px;color:var(--dsw-alias-label-tertiary)}
.nodo-tool-timeline-detail{min-width:0}
@keyframes nodo-timeline-enter{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@keyframes nodo-timeline-shimmer{from{background-position:150% 0}to{background-position:-150% 0}}
@keyframes nodo-timeline-pulse{50%{opacity:.4}}
@media(prefers-reduced-motion:reduce){.nodo-tool-timeline-chevron,.nodo-tool-timeline-panel{transition:none}.nodo-tool-timeline-step,.nodo-tool-timeline-step[data-active=true]>.nodo-tool-timeline-icon{animation:none}.nodo-tool-timeline[data-streaming=true] .nodo-tool-timeline-label{animation:none;background:none;color:var(--dsw-alias-label-secondary)}}
`
