import { h, useState, useEffect, useRef, useSyncExternalStore, useStateView, nativeSpace } from './ui-shared.js'
import { RoleAvatar } from './avatar.tsx'
import AVATAR_TEMPLATES from '../../core/shared/avatar-templates.json'

const RUNNING_COLORS = [...AVATAR_TEMPLATES, ...AVATAR_TEMPLATES.slice(1, -1).reverse()]
const RUNNING_COLOR_HOLD = 3160

export const runDuration = ms => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const parts = []
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const seconds = total % 60
  if (hours > 0) parts.push(`${hours}h`)
  if (hours > 0 || total >= 60) parts.push(`${minutes}m`)
  parts.push(`${seconds}s`)
  return parts.join(' ')
}

export function nativeRunningSince(snapshot) {
  let latest
  for (const turn of snapshot.views.get('chat')?.timeline.turns.values() ?? []) {
    if (!latest || turn.turn > latest.turn) latest = turn
  }
  return latest?.status === 'open' ? latest.start?.time : undefined
}

export function NativeRunningDock({ sessionId, useSession, useConversation }) {
  const space = useSyncExternalStore(nativeSpace.subscribe, nativeSpace.getSnapshot)
  const { view } = useStateView()
  const work = Object.values(view?.profiles ?? {}).flatMap(profile => profile.sessions ?? []).find(session =>
    (session.engine === 'dsh' ? session.driverSessionId : null) === sessionId)
  const engine = work ? view.work?.[work.id]?.engine : undefined
  const running = useSession(session => session.running)
  const since = useConversation(nativeRunningSince)
  return space.active && !space.legacy && running
    ? h('div', { className: 'nodo-running-dock', 'data-nodo-native-running': '' }, h(RunningLine, { key: sessionId, since, engine }))
    : null
}

export function engineRunningLabel(engine, now) {
  if (!engine) return '正在思考'
  const retryText = typeof engine.detail === 'string' && engine.detail ? `（${engine.detail.slice(0, 80)}）` : ''
  const label = ({ 'waiting-question': '等待回答', 'waiting-approval': '等待审批', tool: `正在执行 ${engine.tool ?? '工具'}`, thinking: '正在思考', responding: '正在回复', running: '等待 Agent',
    retrying: `正在重试${retryText}`, compacting: '正在压缩上下文' })[engine.phase] ?? '等待 Agent'
  const silent = Number.isFinite(engine.lastEventAt) ? Math.max(0, now - engine.lastEventAt) : 0
  return silent >= 30000 ? `${label} · ${runDuration(silent)} 未收到新事件` : label
}

export function RunningLine({ since, engine }) {
  const clock = useRef({ since, at: Date.now() })
  if (clock.current.since !== since) clock.current = { since, at: Date.now() }
  const epoch = Number.isFinite(since) ? since : clock.current.at
  const [now, setNow] = useState(() => Date.now())
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [since])
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const elapsed = Math.max(0, now - epoch)
  const label = engineRunningLabel(engine, now)
  const template = RUNNING_COLORS[reduced ? 0 : Math.floor(elapsed / RUNNING_COLOR_HOLD) % RUNNING_COLORS.length]
  const letter = (text, index) => h('span', {
    key: index, className: 'nodo-running-letter', style: { '--nodo-running-stagger': `${180 + index * 45}ms` },
  }, text)
  return h('div', { className: 'nodo-running', 'data-flow': 'process', style: {
    '--nodo-running-tint': template.color,
    '--nodo-running-phase': `${-Math.max(0, clock.current.at - epoch)}ms`,
  } },
  h('span', { className: 'nodo-running-divider', 'aria-hidden': true }),
  h('span', { className: 'nodo-running-line' },
    h('span', { className: 'nodo-running-icon', 'aria-hidden': true },
      h(RoleAvatar, { profile: { avatarTemplate: 'sky' }, size: '100%' })),
    h('span', { className: 'nodo-running-label', 'aria-label': label },
      h('span', { 'aria-hidden': true }, Array.from(label, letter))),
    Number.isFinite(since) && h('span', { className: 'nodo-running-timer' },
      h('span', { className: 'nodo-running-separator', 'aria-hidden': true }),
      h('span', { 'aria-label': `用时 ${runDuration(elapsed)}` },
        h('span', { 'aria-hidden': true }, letter('用', 4), letter('时', 5), ' ',
          h('span', { className: 'nodo-running-time' }, letter(runDuration(elapsed), 6))))),
    h('span', { className: 'nodo-running-dots', 'aria-hidden': true },
      [0, 1, 2].map(index => h('span', { key: index, className: 'nodo-running-dot',
        style: { '--nodo-running-stagger': `${120 + index * 170}ms` } })))))
}

export const RUNNING_CSS = `
[data-conversation-content]:has([data-nodo-native-running]) [data-chat-running]{display:none}
.nodo-running-dock{flex:none;padding:0 calc(var(--dsh-composer-side-clearance,16px) + 16px) 8px}
.nodo-running-dock>.nodo-running{width:100%;max-width:var(--dsh-chat-content-width,748px);margin:0 auto}
.nodo-running{display:flex;flex-direction:column;align-items:flex-start;color:color-mix(in srgb,var(--nodo-running-tint) 38%,var(--dsw-alias-label-primary));font-size:calc(var(--dsh-content-font-size,14px) - 2px);line-height:calc(22px + var(--dsh-content-font-delta,0px))}
.nodo-running-divider{width:100%;height:.5px;margin:8px 0 10px;background:color-mix(in srgb,var(--dsw-alias-border-l1) 75%,var(--dsw-alias-border-l2))}
.nodo-running-line{display:flex;align-items:center;flex-wrap:wrap;gap:4px 6px;min-width:0;max-width:100%;font-variant-numeric:tabular-nums}
.nodo-running-icon{display:inline-flex;flex:none;width:clamp(16px,calc(18px + var(--dsh-content-font-delta,0px)),20px);height:clamp(16px,calc(18px + var(--dsh-content-font-delta,0px)),20px);transform-origin:50% 85%;animation:nodo-running-hop 1.58s infinite;animation-delay:var(--nodo-running-phase)}
.nodo-running-icon .nodo-avatar-body{fill:var(--nodo-running-tint)}
.nodo-running-icon .nodo-avatar-tile{fill:color-mix(in srgb,var(--nodo-running-tint) 20%,var(--dsw-alias-bg-base))}
.nodo-running-label,.nodo-running-timer{white-space:nowrap}
.nodo-running-letter{display:inline-block;white-space:pre;animation:nodo-running-wave 1.58s ease-in-out infinite;animation-delay:calc(var(--nodo-running-phase) + var(--nodo-running-stagger))}
.nodo-running-timer{display:inline-flex;align-items:center;gap:6px}
.nodo-running-time{display:inline-block;min-width:3ch}
.nodo-running-separator{height:1em;width:.5px;background:currentColor;opacity:.25}
.nodo-running-dots{display:inline-flex;align-items:center;gap:3px;flex:none}
.nodo-running-dot{width:3px;height:3px;border-radius:50%;background:var(--nodo-running-tint);animation:nodo-running-dot 1.58s ease-in-out infinite;animation-delay:calc(var(--nodo-running-phase) + var(--nodo-running-stagger))}
@keyframes nodo-running-hop{0%,68%,100%{transform:translateY(0) rotate(0) scale(1)}10%{transform:translateY(0) scale(1.08,.9);animation-timing-function:ease-out}30%{transform:translateY(-3px) rotate(-5deg) scale(.96,1.04);animation-timing-function:ease-in}48%{transform:translateY(0) rotate(2deg) scale(1.07,.91);animation-timing-function:ease-out}}
@keyframes nodo-running-wave{0%,35%,100%{transform:translateY(0)}15%{transform:translateY(-1px)}}
@keyframes nodo-running-dot{0%,36%,100%{transform:translateY(0);opacity:.6}16%{transform:translateY(-2px);opacity:1}}
@media(prefers-reduced-motion:reduce){.nodo-running-icon,.nodo-running-letter,.nodo-running-dot{animation:none}}
@media(max-width:820px){.nodo-running-dock{padding-right:16px;padding-left:16px}}
`
