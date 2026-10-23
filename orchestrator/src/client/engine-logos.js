// Engine marks: the official brand artwork inlined at build time from
// src/client/assets/engines/*.svg (each vendor's own favicon/logo; Codex and
// DSH from Simple Icons — see THIRD_PARTY_NOTICES.txt). Monochrome marks carry fill="currentColor" and so
// follow the theme; Claude, DeepSeek and CodeBuddy keep their official brand colors. An
// engine without a stored mark falls back to the host's generic code icon.
// Card titles: the product name, without build-channel suffixes (…CLI, (native))
// the driver labels carry.
const engineDisplayName = item => ENGINE_NAMES[item.id] ?? String(item.label ?? item.id).replace(/\s*CLI$/, '')

function EngineMark({ engine, size = 20 }) {
  const svg = ENGINE_LOGO_SVGS[engine]
  if (!svg) return h(IconCodeOutlineRegular, { size })
  return h('span', { className: 'nodo-engine-art', style: { width: size, height: size },
    dangerouslySetInnerHTML: { __html: svg }, 'aria-hidden': true })
}

const ENGINE_LOGO_CSS = `
.nodo-engine-art{display:inline-block;flex:none}
.nodo-engine-art>svg{display:block;width:100%;height:100%}
`
