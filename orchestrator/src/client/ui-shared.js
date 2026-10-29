// CJS factory body for DSH's classic-script client loader. React is supplied by
// the shell's module table. Every surface the panel draws — rail rows, message
// rows, tool and thinking rows, composer, dialogs, form controls — is either a
// component from the host's own UI kit or a copy of the host's CSS values, and
// takes its color, radius, shadow and type scale from the --dsw-* / --dsh-*
// variables the shell already publishes, so the page follows the product look in
// light, dark and any font-size setting.
import { createElement as h, Fragment, useState, useEffect, useLayoutEffect, useMemo, useRef, useId, useSyncExternalStore } from 'react'
/** @typedef {import('react').ReactNode} ReactNode */
// The shell seeds this UI kit in the same module table as React, so the panel
// reuses the host's own controls, rows, markdown renderer and icon artwork (the
// native packages require it the same way).
import {
  Button, CodeBlock, DisclosureRow, DiffBlock, diffTotals, writeClipboard, TerminalBlock, ImageLightbox, Input, MarkdownText, Menu, Modal, RiskConfirmation, StateDot, Tooltip, relativeTime,
  IconApiOutlineRegular, IconBrowseOutlineRegular, IconChevronDownOutlineRegular,
  IconCheckOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconCodeOutlineRegular, IconCompactOutlineRegular,
  IconEditOutlineRegular, IconEllipsisOutlineRegular, IconFlatListOutlineRegular, IconFolderOpenOutlineRegular, IconGoalOutlineRegular, IconNewChatOutlineRegular,
  IconPaperclipOutlineRegular, IconPanelLeftOutlineRegular, IconCloseOutlineRegular,
  IconPlanOutlineRegular, IconPlusOutlineRegular,
  IconProjectAddOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular, IconSettingsOutlineRegular, IconSlidersTwoOutlineRegular,
  IconSparkleRegular, IconThinkOutlineRegular, IconTrashOutlineRegular, IconUsersOutlineRegular,
  IconArchiveOutlineRegular, IconArchiveOffOutlineRegular, IconPinFillRegular, IconPinOutlineRegular, IconDatabaseOutlineRegular, IconGaugeOutlineRegular,
  IconBranchOutlineRegular,
  IconWorkspaceTreeOutlineRegular, PermissionIconFullAccessRegular, PermissionIconReadOnlyRegular, PermissionIconWorkspaceWriteRegular,
  IconDataOutlineRegular, IconGlobeOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import NODO_LOGO from './assets/nodo-logo.png'

export { h, Fragment, useState, useEffect, useLayoutEffect, useMemo, useRef, useId, useSyncExternalStore }
export {
  Button, CodeBlock, DisclosureRow, DiffBlock, diffTotals, writeClipboard, TerminalBlock, ImageLightbox, Input, MarkdownText, Menu, Modal, RiskConfirmation, StateDot, Tooltip, relativeTime,
  IconApiOutlineRegular, IconBrowseOutlineRegular, IconChevronDownOutlineRegular,
  IconCheckOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconCodeOutlineRegular, IconCompactOutlineRegular,
  IconEditOutlineRegular, IconEllipsisOutlineRegular, IconFlatListOutlineRegular, IconFolderOpenOutlineRegular, IconGoalOutlineRegular, IconNewChatOutlineRegular,
  IconPaperclipOutlineRegular, IconPanelLeftOutlineRegular, IconCloseOutlineRegular,
  IconPlanOutlineRegular, IconPlusOutlineRegular,
  IconProjectAddOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular, IconSettingsOutlineRegular, IconSlidersTwoOutlineRegular,
  IconSparkleRegular, IconThinkOutlineRegular, IconTrashOutlineRegular, IconUsersOutlineRegular,
  IconArchiveOutlineRegular, IconArchiveOffOutlineRegular, IconPinFillRegular, IconPinOutlineRegular, IconDatabaseOutlineRegular, IconGaugeOutlineRegular,
  IconBranchOutlineRegular,
  IconWorkspaceTreeOutlineRegular, PermissionIconFullAccessRegular, PermissionIconReadOnlyRegular, PermissionIconWorkspaceWriteRegular,
  IconDataOutlineRegular, IconGlobeOutlineRegular,
}

export const PANEL_ID = 'nodo'
const ROUTE = '/api/nodo'
// Form ids let a dialog's footer button submit the form that lives in its body.
export const ROLE_FORM = 'nodo-role-form'
export const WORKSPACE_FORM = 'nodo-workspace-form'
export const WORKTREE_FORM = 'nodo-worktree-form'
export const GOAL_FORM = 'nodo-goal-form'
export const ENGINE_FORM = 'nodo-engine-form'
// Set in apply() when the shell's uiWorkspace service (declared in inject) offers
// the native OS directory chooser; null means fall back to typing a path.
export let nativePickDirectory = null
export let openNativeSession = null
export let nativeSpace = null
export let completionTracker = null
export let nativeSessionState = null
export let NewConversation = null
export const readNativeSession = () => nativeSessionState.getSnapshot().key
export const subscribeNativeSession = listener => nativeSessionState.subscribe(listener)
/** @type {{ selectPanel?: (key: string | null) => void, toggleSidebar?: () => void, openRightbar?: (track: boolean, fullscreen: boolean) => void, closeRightbar?: () => void } | null} */
export let layoutService = null
/** @type {import('./right-panel.tsx').RightPanelService} */
export let rightPanelService

// apply() seeds the host services once per registration; the modules above read
// them through these live bindings.
export function setHostServices(services) {
  nativePickDirectory = services.nativePickDirectory
  openNativeSession = services.openNativeSession
  nativeSpace = services.nativeSpace
  completionTracker = services.completionTracker
  nativeSessionState = services.nativeSessionState
  NewConversation = services.NewConversation
  layoutService = services.layoutService
  rightPanelService = services.rightPanelService
}

export const call = async (endpoint, payload) => {
  const response = await fetch(ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
  })
  const answer = await response.json()
  if (answer?.ok !== true) throw new Error(answer?.error?.message ?? 'request failed')
  return answer.value
}

export const readImage = file => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve({ name: file.name, mediaType: file.type, dataUrl: reader.result })
  reader.onerror = () => reject(reader.error)
  reader.readAsDataURL(file)
})

/** @returns {{ view: any, error: string, refresh: (force?: boolean) => Promise<void> }} */
export function useStateView() {
  const [view, setView] = useState(null)
  const [error, setError] = useState('')
  const live = useRef(false)
  const snapshot = useRef(null)
  const requested = useRef(0)
  const applied = useRef(0)

  const refresh = async (force = false) => {
    const order = ++requested.current
    try {
      const answer = await call('state', force ? undefined : { since: snapshot.current?.revision })
      if (!live.current || order < applied.current) return
      applied.current = order
      const next = answer.unchanged && snapshot.current !== null
        ? { ...snapshot.current, work: answer.work, approvals: answer.approvals, stats: answer.stats, runs: answer.runs }
        : answer
      snapshot.current = next
      setView(next)
      setError('')
    } catch (failure) {
      if (live.current && order >= applied.current) setError(failure.message)
    }
  }

  useEffect(() => {
    live.current = true
    void refresh(true)
    let timer = null
    // A live turn shortens the cadence so the feed grows at the host chat's own
    // rhythm instead of arriving in visible jumps.
    const schedule = () => {
      const busy = Object.values(snapshot.current?.work ?? {}).some(state => state?.active === true)
      timer = setTimeout(() => { void refresh(); schedule() }, busy ? 400 : 1200)
    }
    schedule()
    return () => { live.current = false; clearTimeout(timer) }
  }, [])

  return { view, error, refresh }
}

// The host amber is too light for text on light surfaces; mixing toward the label colour keeps it readable in both themes.
export const WARN_INK = 'color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,var(--dsw-alias-label-primary))'

// Markdown chrome for the host's own renderer, word for word from the shell's
// Chinese dictionary (dsh-client-locale: copy / copied / codeBlock.* / footnotes).
export const MARKDOWN_LABELS = {
  code: { copyLabel: '复制', copiedLabel: '复制成功', toolbarLabels: { codeLabel: '代码块', wrapLabel: '自动换行', unwrapLabel: '取消自动换行' } },
  footnotes: '脚注',
}

// One tool call reads like the host's own tool rows: the host's variant glyph and
// its localized title, then a one-line summary. Variants and titles are the ones
// dsh-client-ui-tool uses (search / read / bash / write / edit / code / generic).
export const TOOL_VARIANTS = {
  search: { title: '搜索', icon: IconSearchOutlineRegular },
  read: { title: '读取', icon: IconBrowseOutlineRegular },
  bash: { title: '运行命令', icon: IconApiOutlineRegular },
  write: { title: '写入', icon: IconEditOutlineRegular },
  edit: { title: '编辑', icon: IconEditOutlineRegular },
  code: { title: '代码', icon: IconCodeOutlineRegular },
  plan: { title: '计划', icon: IconPlanOutlineRegular },
  task: { title: '子任务', icon: IconUsersOutlineRegular },
  generic: { title: '工具调用', icon: IconSparkleRegular },
}

export function toolVariant(name) {
  const id = String(name ?? '')
  if (/^(read|view|open|read_image|readImage)/i.test(id)) return 'read'
  if (/^(grep|glob|search|find|lsp|list|ls$)/i.test(id)) return 'search'
  if (/^(bash|shell|command|pwsh|terminal|execute|run)/i.test(id)) return 'bash'
  if (/^(write|create|apply[_-]?patch|new_?file)/i.test(id)) return 'write'
  if (/^(edit|file[_-]?change|multi[_-]?edit|str[_-]?replace|replace)/i.test(id)) return 'edit'
  if (/^code/i.test(id)) return 'code'
  if (/^(subagent|task|workflow|collab)/i.test(id)) return 'task'
  return 'generic'
}

// The composer's send and stop glyphs are the host's own 16-unit artwork; no icon
// in the kit is geometrically the same.
const GLYPH = {
  send: 'M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z',
}

export const ComposerGlyph = (running) => h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true },
  running
    ? h('rect', { x: 3, y: 3, width: 10, height: 10, rx: 3, fill: 'currentColor' })
    : h('path', { fill: 'currentColor', d: GLYPH.send }))

export const workLabel = work => work?.seen ? ''
  : ({ 'waiting-approval': '等待审批', 'waiting-question': '等待回答', completed: '已完成', stopped: '已停止', blocked: '未完成', error: '执行失败', unavailable: '状态不可用' })[work?.status]
  ?? (work?.suspect ? '疑似卡住' : work?.active ? '运行中' : '')
export const workDot = work => work?.suspect || work?.status?.startsWith('waiting-') || work?.status === 'blocked' ? 'warning'
  : work?.active ? 'ongoing' : work?.status === 'completed' ? 'done' : work?.status === 'error' ? 'error' : 'idle'
export const runningOf = (profile, work) => {
  const states = (profile.sessions ?? []).map(session => work?.[session.id]).filter(Boolean)
  const active = states.filter(state => state.active)
  const current = active.find(state => state.status === 'waiting-question') ?? active.find(state => state.status === 'waiting-approval')
    ?? active[0] ?? states.filter(state => state.finishedAt && !state.seen).sort((a, b) => b.finishedAt - a.finishedAt)[0]
  return { ...current, active: active.length > 0, queued: states.reduce((total, state) => total + (state.queued ?? 0), 0) }
}
export const workspaceIdOf = (view, role, session) => session.workspaceRef ?? view.workspaces.find(item => item.cwd === session.cwd)?.id ?? role.workspaceId
// Runs and waits are global, but a finished label only counts sessions this
// workspace lists: an unread turn archived away or left in another project has
// no row here to open, and would pin the label on the role forever.
export const roleStateOf = (profile, view, workspace) => {
  const live = runningOf(profile, view.work)
  if (live.active) return live
  const visible = (profile.sessions ?? []).filter(session => !session.archivedAt && workspaceIdOf(view, profile, session) === workspace?.id)
  return { ...runningOf({ ...profile, sessions: visible }, view.work), queued: live.queued }
}

// Session rows date themselves through the host's own bucketing (relativeTime)
// and the host's own Chinese words (dsh-client-ui-workspace: time.*).
const TIME_WORDS = { now: '刚刚', minutes: '{n}分钟', hours: '{n}小时', days: '{n}天', months: '{n}个月', years: '{n}年', ago: '{t}前' }

export const sessionTime = at => {
  if (!Number.isFinite(at)) return ''
  const { unit, n } = relativeTime(at, Date.now())
  if (unit === 'now') return TIME_WORDS.now
  return TIME_WORDS.ago.replace('{t}', TIME_WORDS[unit].replace('{n}', String(n)))
}

// The host chat's own number words for the statistics line: exact below a
// thousand, then K/M with its rounding, grouped digits for the dialog, and
// durations as 45.2秒 / 2分42秒.
export const exactTokens = value => String(Math.max(0, Math.round(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
export const compactTokens = (value) => {
  if (value < 1000) return String(Math.round(value))
  const scaled = candidate => (candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10))
  return value < 1e6 ? `${scaled(value / 1e3)}K` : `${scaled(value / 1e6)}M`
}
export const compactDuration = (ms) => {
  const seconds = ms / 1000
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}秒`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}分${whole % 60}秒`
}
export const tokensPerSecond = (tokens, ms) => {
  const rate = Math.max(0, tokens / (ms / 1000))
  return rate >= 10 ? String(Math.round(rate)) : String(Math.round(rate * 10) / 10)
}
// The prompt side of the bill, and the share of it the provider served from its
// cache: a full hit reads 100, a near miss keeps one decimal instead of lying,
// and a session with no cache reads shows no share at all — once the turns are
// summed, an unreported bucket and a real miss look the same.
export const billedTokens = stats => stats.inputTokens + stats.cacheReadTokens + stats.cacheWriteTokens
export const cacheHitPercent = (stats) => {
  const billed = billedTokens(stats)
  if (billed === 0 || stats.cacheReadTokens === 0) return ''
  const exact = (stats.cacheReadTokens / billed) * 100
  const rounded = Math.round(exact)
  return String(rounded === 100 && stats.cacheReadTokens < billed ? Math.round(exact * 10) / 10 : rounded)
}
export const contextPercent = stats => (stats.contextSize > 0 ? Math.round((stats.contextUsed / stats.contextSize) * 100) : null)
export const turnTokens = usage => (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)

export function NodoLogo({ width = 112, compact = false } = {}) {
  const maskId = `nodo-logo-${useId()}`
  const artwork = () => h('image', { href: NODO_LOGO, width: 2172, height: 724 })
  return h('svg', { className: 'nodo-logo', viewBox: compact ? '675 170 420 400' : '280 170 1610 400', width, height: compact ? width : width / 4,
    role: 'img', 'aria-label': 'NODO', focusable: false },
    h('defs', null, h('mask', { id: maskId, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: 2172, height: 724, style: { maskType: 'alpha' } }, artwork())),
    artwork(),
    h('g', { mask: `url(#${maskId})`, fill: 'currentColor' },
      h('rect', { x: 280, y: 170, width: 385, height: 400 }),
      h('rect', { x: 1090, y: 170, width: 385, height: 400 })))
}

// The archived filter's three views, named as the host sidebar names them.
export const ARCHIVED_VIEWS = { hide: '隐藏已归档', all: '全部对话（显示已归档）', only: '仅显示已归档' }
// A long session list folds to its ten most recent rows behind a 显示更多 toggle.
export const SESSION_FOLD = 10
