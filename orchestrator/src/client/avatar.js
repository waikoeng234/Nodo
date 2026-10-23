const avatarTemplateOf = (profile = {}) => AVATAR_TEMPLATES.find(item => item.id === profile.avatarTemplate)
  ?? AVATAR_TEMPLATES[Array.from(profile.id || profile.name || '').reduce((sum, letter) => sum + letter.codePointAt(0), 0) % AVATAR_TEMPLATES.length]

function RoleAvatar({ profile, running = false, size = 32 }) {
  const template = avatarTemplateOf(profile)
  return h('span', { className: 'nodo-avatar', 'data-running': running ? 'true' : undefined,
    'data-template': template.id, 'aria-hidden': true, style: { width: size, height: size } },
    h('svg', { className: 'nodo-avatar-art', viewBox: '0 0 64 64', width: size, height: size, focusable: false },
      h('path', { d: template.shape, fill: template.color }),
      h('g', { transform: `rotate(${template.tilt} 32 30)` },
        h('g', { className: 'nodo-avatar-eyes', fill: '#172021' },
          h('rect', { x: 21, y: 23, width: 5.5, height: 15, rx: 2.75 }),
          h('rect', { x: 38, y: 23, width: 5.5, height: 15, rx: 2.75 })))))
}

const AVATAR_CSS = `
.nodo-avatar{display:inline-flex;align-items:center;justify-content:center;flex:none}
.nodo-avatar-art{display:block;overflow:visible;transform-origin:50% 85%}
.nodo-avatar-eyes{transform-box:fill-box;transform-origin:center}
.nodo-avatar[data-running=true] .nodo-avatar-art{animation:nodo-avatar-hop 1.6s ease-in-out infinite}
.nodo-avatar[data-running=true] .nodo-avatar-eyes{animation:nodo-avatar-blink 3.8s ease-in-out infinite}
.nodo-role-select:hover .nodo-avatar:not([data-running]) .nodo-avatar-art{animation:nodo-avatar-greet .45s ease-in-out}
.nodo-avatar-picker{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.nodo-avatar-option{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0;min-height:78px;padding:10px 4px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.nodo-avatar-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-avatar-option[aria-pressed=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-specific-sidebar-nav-item-active-accent);color:var(--dsw-alias-label-primary)}
.nodo-avatar-option:focus-visible,.nodo-avatar-preview-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.nodo-avatar-option:disabled{opacity:.5;cursor:default}
.nodo-avatar-preview-toggle{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
@keyframes nodo-avatar-hop{0%,100%{transform:translateY(0) rotate(-3deg) scale(1.02,.98)}50%{transform:translateY(-3px) rotate(4deg) scale(.98,1.02)}}
@keyframes nodo-avatar-blink{0%,42%,48%,100%{transform:scaleY(1)}45%{transform:scaleY(.12)}}
@keyframes nodo-avatar-greet{0%,100%{transform:rotate(0)}35%{transform:rotate(-9deg)}70%{transform:rotate(7deg)}}
@media(prefers-reduced-motion:reduce){.nodo-avatar .nodo-avatar-art,.nodo-avatar .nodo-avatar-eyes{animation:none!important}}
`
