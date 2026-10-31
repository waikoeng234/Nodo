import { h, IconPaperclipOutlineRegular } from './ui-shared.js'
import { FILE_ICON_URLS } from 'nodo:file-icons'
import type { ReactNode } from './ui-shared.js'

// 文件类型图标：material-icon-theme 子集（见 THIRD_PARTY_NOTICES.txt），构建期
// 内联为 data URL。文件名特例优先于扩展名；目录图标仍用宿主 kit 的文件夹图标，
// 没有匹配的文件落回 kit 的回形针图标。
const NAME_ICONS: Record<string, string> = {
  'package.json': 'npm',
  dockerfile: 'docker',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.env': 'document',
}
const EXT_ICONS: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'react',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'react_ts',
  json: 'json', md: 'markdown', css: 'css', sass: 'sass', scss: 'sass', html: 'html', htm: 'html',
  vue: 'vue', svelte: 'svelte', py: 'python', go: 'go', rs: 'rust', java: 'java',
  kt: 'kotlin', kts: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', rb: 'ruby', php: 'php', sh: 'console', bash: 'console', zsh: 'console', fish: 'console',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', xml: 'xml', sql: 'database', lock: 'lock',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image',
  svg: 'svg', pdf: 'pdf', zip: 'zip', tar: 'zip', gz: 'zip', tgz: 'zip', bz2: 'zip', xz: 'zip', rar: 'zip', '7z': 'zip',
  txt: 'document', log: 'log',
}

export function fileIconKey(name: string): string | null {
  const base = name.split('/').at(-1)?.toLowerCase() ?? ''
  if (base.startsWith('readme')) return 'readme'
  if (base.startsWith('license')) return 'license'
  if (NAME_ICONS[base]) return NAME_ICONS[base]
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? EXT_ICONS[base.slice(dot + 1)] ?? null : null
}

export function FileIcon({ name, size = 14, fallback }: { name: string; size?: number; fallback?: ReactNode }) {
  const url = FILE_ICON_URLS[fileIconKey(name) ?? '']
  if (!url) return fallback ?? h(IconPaperclipOutlineRegular, { size })
  return h('img', { className: 'nodo-file-art', src: url, width: size, height: size, alt: '', 'aria-hidden': true })
}

export const FILE_ICON_CSS = `
.nodo-file-art{display:block;flex:none;object-fit:contain}
`
