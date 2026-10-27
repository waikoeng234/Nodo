import { h } from './ui-shared.js'
import AVATAR_TEMPLATES from '../../core/shared/avatar-templates.json'

export type AvatarTemplate = (typeof AVATAR_TEMPLATES)[number]
export interface RoleAvatarProfile { avatarTemplate?: string; id?: string; name?: string }
export interface RoleAvatarProps { profile: RoleAvatarProfile; running?: boolean; size?: number }

export const avatarTemplateOf = (profile: RoleAvatarProfile = {}): AvatarTemplate =>
  AVATAR_TEMPLATES.find(item => item.id === profile.avatarTemplate)
  ?? AVATAR_TEMPLATES[Array.from(profile.id || profile.name || '').reduce((sum, letter) => sum + (letter.codePointAt(0) ?? 0), 0) % AVATAR_TEMPLATES.length]

export function RoleAvatar({ profile, running = false, size = 32 }: RoleAvatarProps) {
  const template = avatarTemplateOf(profile)
  return (
    <span className="nodo-avatar" data-running={running ? 'true' : undefined}
      data-template={template.id} aria-hidden style={{ width: size, height: size, color: template.color }}>
      <svg viewBox="0 0 64 64" width={size} height={size} focusable={false}>
        <rect className="nodo-avatar-tile" width={64} height={64} rx={18} />
        <g transform="translate(6.86 6.86) scale(.786)">
          <g className="nodo-avatar-art">
            <path className="nodo-avatar-body" d={template.shape} fill={template.color} />
            <g transform={`rotate(${template.tilt} 32 30)`}>
              <g className="nodo-avatar-eyes" fill="#172021">
                <rect x={21} y={23} width={5.5} height={15} rx={2.75} />
                <rect x={38} y={23} width={5.5} height={15} rx={2.75} />
              </g>
            </g>
          </g>
        </g>
      </svg>
    </span>
  )
}

export const AVATAR_CSS = `
.nodo-avatar{display:inline-flex;align-items:center;justify-content:center;flex:none;border-radius:28%}
.nodo-avatar>svg{display:block;overflow:visible}
.nodo-avatar-tile{fill:color-mix(in srgb,currentColor 20%,var(--dsw-alias-bg-base))}
.nodo-avatar-art{transform-box:fill-box;transform-origin:50% 85%}
.nodo-avatar-eyes{transform-box:fill-box;transform-origin:center}
.nodo-avatar[data-running=true] .nodo-avatar-art{animation:nodo-avatar-hop 1.6s ease-in-out infinite}
.nodo-avatar[data-running=true] .nodo-avatar-eyes{animation:nodo-avatar-blink 3.8s ease-in-out infinite}
.nodo-roster-item:hover .nodo-avatar:not([data-running]) .nodo-avatar-art{animation:nodo-avatar-greet .45s ease-in-out}
.nodo-avatar-picker{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.nodo-avatar-option{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0;min-height:78px;padding:10px 4px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.nodo-avatar-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-avatar-option[aria-pressed=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-specific-sidebar-nav-item-active-accent);color:var(--dsw-alias-label-primary)}
.nodo-avatar-option:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.nodo-avatar-option:disabled{opacity:.5;cursor:default}
@keyframes nodo-avatar-hop{0%,100%{transform:translateY(0) rotate(-3deg) scale(1.02,.98)}50%{transform:translateY(-8px) rotate(4deg) scale(.98,1.02)}}
@keyframes nodo-avatar-blink{0%,42%,48%,100%{transform:scaleY(1)}45%{transform:scaleY(.12)}}
@keyframes nodo-avatar-greet{0%,100%{transform:rotate(0)}35%{transform:rotate(-9deg)}70%{transform:rotate(7deg)}}
@media(prefers-reduced-motion:reduce){.nodo-avatar .nodo-avatar-art,.nodo-avatar .nodo-avatar-eyes{animation:none!important}}
`
