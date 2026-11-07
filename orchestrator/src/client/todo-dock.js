// The agent's task list as a collapsible card: above the composer in a session
// page and inside each member card in a team round, mirroring the native host's
// todo panel — a header with live per-status counts and a StateDot list.
import {
  h, useState, useEffect, useSyncExternalStore, StateDot,
  IconChecklistOutlineRegular, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular,
} from './ui-shared.js'
import { transcriptOf, watchTranscript, subscribeStore, getStoreVersion } from './live.js'

const EMPTY = []
const DOT = { completed: 'done', in_progress: 'ongoing', pending: 'idle' }
const WORD = { completed: '已完成', in_progress: '进行中', pending: '待办' }

// " ·"-joined per-status counts; zero segments are omitted as noise.
const progress = steps => {
  const counts = { completed: 0, in_progress: 0, pending: 0 }
  for (const step of steps) counts[(step.status ?? 'pending') in counts ? step.status : 'pending'] += 1
  return Object.entries(counts).filter(([, count]) => count > 0).map(([status, count]) => `${WORD[status]} ${count}`).join(' · ')
}

export function PlanDock({ profileId, sessionId, compact, selectLines }) {
  const [collapsed, setCollapsed] = useState(true)
  useSyncExternalStore(subscribeStore, getStoreVersion)
  useEffect(() => sessionId ? watchTranscript(profileId, sessionId) : undefined, [profileId, sessionId])
  const lines = sessionId ? transcriptOf(`${profileId}:${sessionId}`) : EMPTY
  const plan = (selectLines ? selectLines(lines) : lines).findLast(line => line.kind === 'plan')
  const steps = plan && plan.removed !== true && Array.isArray(plan.steps) ? plan.steps : []
  if (!sessionId || steps.length === 0) return null
  return h('section', { className: 'nodo-todo-dock', 'data-compact': compact ? '' : undefined, 'aria-label': '任务清单' },
    h('button', { type: 'button', className: 'nodo-todo-dock-head', 'aria-expanded': !collapsed, onClick: () => setCollapsed(value => !value) },
      h('span', { className: 'nodo-todo-dock-lead', 'aria-hidden': true }, h(IconChecklistOutlineRegular, { size: 16 })),
      h('span', { className: 'nodo-todo-dock-title' }, '任务清单'),
      h('span', { className: 'nodo-todo-dock-progress' }, progress(steps)),
      h('span', { className: 'nodo-todo-dock-chevron', 'aria-hidden': true },
        h(collapsed ? IconChevronUpOutlineRegular : IconChevronDownOutlineRegular, { size: 14 }))),
    !collapsed && h('ul', { className: 'nodo-todo-dock-list' },
      steps.map((step, index) => h('li', { key: index, className: 'nodo-todo-dock-item', 'data-status': step.status ?? 'pending' },
        h('span', { className: 'nodo-todo-dock-glyph', 'aria-hidden': true }, h(StateDot, { state: DOT[step.status] ?? 'idle', size: 8 })),
        h('span', { className: 'nodo-todo-dock-content', title: step.text }, step.text)))))
}

export const TODO_DOCK_CSS = `
.nodo-todo-dock{box-sizing:border-box;flex:none;display:flex;flex-direction:column;gap:8px;width:calc(100% - 32px);max-width:calc(var(--dsh-chat-content-width,748px) + 32px);margin:0 auto 8px;padding:6px 12px;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);box-shadow:var(--dsw-elevation-panel);overflow:hidden}
.nodo-todo-dock-head{display:flex;align-items:center;gap:10px;width:100%;padding:0;border:0;background:0 0;cursor:pointer;text-align:left;font:inherit}
.nodo-todo-dock-lead{display:grid;place-items:center;flex:none;color:var(--dsw-alias-label-tertiary)}
.nodo-todo-dock-title{flex:none;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:24px}
.nodo-todo-dock-progress{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:13px;font-weight:400;line-height:20px}
.nodo-todo-dock-chevron{display:grid;place-items:center;flex:none;color:var(--dsw-alias-label-tertiary)}
.nodo-todo-dock-list{display:flex;flex-direction:column;gap:8px;max-height:180px;margin:0;padding:0;list-style:none;overflow-y:auto;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.nodo-todo-dock-item{display:flex;align-items:center;gap:10px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.nodo-todo-dock-glyph{display:grid;place-items:center;flex:none;width:16px;height:16px}
.nodo-todo-dock-content{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-todo-dock[data-compact]{position:sticky;top:0;z-index:3;width:100%;max-width:none;margin:2px 0;padding:4px 10px;gap:6px;border-radius:var(--dsw-radius-md);background:var(--dsw-specific-sidebar-fill);box-shadow:none}
.nodo-todo-dock[data-compact] .nodo-todo-dock-list{max-height:140px;gap:6px}
.nodo-todo-dock[data-compact] .nodo-todo-dock-head{gap:8px}
`
