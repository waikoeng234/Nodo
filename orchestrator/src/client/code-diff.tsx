import { h, useEffect, useMemo, useState, CodeBlock, DiffBlock, diffTotals, writeClipboard, IconCodeOutlineRegular } from './ui-shared.js'
import { parsedPatch, patchCounts } from './file-diffs.ts'

export interface FileDiff { path: string; oldText: string | null; newText: string }
export interface CodeDiffProps {
  filename: string
  diff?: FileDiff
  patch?: string
  cycle?: string | number
}

const LABELS = { copy: '复制', copied: '已复制', collapseAria: '收起差异', expandAria: (n: number) => `展开其余 ${n} 行`,
  collapse: '收起', expand: (n: number) => `展开其余 ${n} 行` }
const PREVIEW_LINES = 200

export function CodeDiff({ filename, diff, patch, cycle = 0 }: CodeDiffProps) {
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => { setExpanded(false); setCopied(false) }, [filename, patch, cycle])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])
  const diffs = diff ? [diff] : []
  const parsed = useMemo(() => !diff && patch !== undefined ? parsedPatch(patch) : null, [diff, patch])
  const fragment = parsed?.some(file => file.oldHeader === 'Nodo replacement fragment')
  const totals: { added: number; removed: number } | null = diff ? diffTotals(diffs) : parsed ? patchCounts(parsed) : null
  const lines = useMemo(() => parsed?.flatMap(file => file.hunks.flatMap(hunk => [
    { kind: 'meta', text: `@@ ${file.oldHeader === 'Nodo replacement fragment' ? '片段内 ' : ''}-${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` },
    ...hunk.lines.map(text => ({ kind: text.startsWith('+') ? 'added' : text.startsWith('-') ? 'removed' : text.startsWith('\\') ? 'meta' : 'context', text })),
  ])), [parsed])
  if (!diff && patch === undefined) return null
  return (
    <div className="nodo-code-diff" data-slot="code-diff">
      <div className="nodo-code-diff-header">
        <span className="nodo-code-diff-icon" aria-hidden><IconCodeOutlineRegular size={14} /></span>
        <span className="nodo-code-diff-filename" title={filename}>{filename}{fragment ? ' · 替换片段' : ''}</span>
        {totals && <span className="nodo-code-diff-counts" aria-label={`新增 ${totals.added} 行，删除 ${totals.removed} 行`}>
          <span className="nodo-code-diff-added">+{totals.added}</span>
          <span className="nodo-code-diff-removed">−{totals.removed}</span>
        </span>}
        {parsed && <button type="button" className="nodo-code-diff-copy" onClick={async () => {
          if (patch !== undefined && await writeClipboard(patch)) setCopied(true)
        }}>{copied ? LABELS.copied : LABELS.copy}</button>}
      </div>
      {diff ? <DiffBlock key={cycle} className="nodo-code-diff-native" diffs={diffs} labels={LABELS} />
        : lines ? <pre className="nodo-code-diff-patch" tabIndex={0} aria-label={`${filename} 差异`}>
          <code>{(expanded ? lines : lines.slice(0, PREVIEW_LINES)).map((line, index) => <span key={`${cycle}:${index}`} className="nodo-code-diff-line" data-kind={line.kind}
            style={{ animationDelay: `${Math.min(index * 60, 900)}ms` }}>{line.text}</span>)}</code>
        </pre> : <CodeBlock key={cycle} className="nodo-code-diff-native" code={patch} lang="diff" copyLabel={LABELS.copy} copiedLabel={LABELS.copied} />}
      {lines && lines.length > PREVIEW_LINES && <button type="button" className="nodo-code-diff-expand" aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}>{expanded ? LABELS.collapse : LABELS.expand(lines.length - PREVIEW_LINES)}</button>}
    </div>
  )
}

// DiffBlock owns parsing, copying, wrapping and collapsed context. Its semantic
// CSS module names let this skin follow those rows without pinning their hashes.
export const CODE_DIFF_CSS = `
.nodo-code-diff{position:relative;min-width:0;max-width:100%;margin:6px 0;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);overflow:hidden;background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-primary)}
.nodo-code-diff-header{display:flex;align-items:center;gap:8px;min-height:36px;min-width:0;padding:6px 84px 6px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);font:var(--dsw-font-markdown-code-block-small)}
.nodo-code-diff-icon{display:flex;flex:none;color:var(--dsw-alias-label-tertiary)}
.nodo-code-diff-filename{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-code-diff-counts{display:inline-flex;gap:6px;flex:none;font-size:12px}
.nodo-code-diff-copy{position:absolute;top:6px;right:10px;padding:2px 6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;cursor:pointer}
.nodo-code-diff-copy:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary)}
.nodo-code-diff-expand{margin:4px 12px;padding:4px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}
.nodo-code-diff-expand:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary)}
.nodo-code-diff-patch{max-width:100%;max-height:420px;margin:0;padding:8px 0;overflow:auto;font:var(--dsw-font-markdown-code-block-small)}
.nodo-code-diff-line{display:block;min-width:100%;width:max-content;min-height:22px;padding:1px 12px;line-height:22px;white-space:pre;animation:nodo-code-diff-enter 220ms ease-out both}
.nodo-code-diff-line[data-kind=added]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.nodo-code-diff-line[data-kind=removed]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.nodo-code-diff-line[data-kind=meta]{color:var(--dsw-alias-label-tertiary)}
.nodo-code-diff-added{color:var(--dsw-alias-state-success-primary)}
.nodo-code-diff-removed{color:var(--dsw-alias-state-error-primary)}
.nodo-code-diff-native{position:static!important;overflow:visible!important;margin:0!important;border:0!important;border-radius:0!important;background:transparent!important;box-shadow:none!important}
.nodo-code-diff-native>[data-code-block-banner]{position:absolute;top:0;right:0;height:36px;min-height:0;max-width:80px;padding:0 8px;border:0;background:transparent}
.nodo-code-diff-native>[data-code-block-banner]>:first-child{display:none}
.nodo-code-diff-native[data-diff]>div:last-child{min-height:16px;max-width:100%;overflow-x:auto;padding:8px 0;font:var(--dsw-font-markdown-code-block-small)}
.nodo-code-diff-native[data-diff][data-code-wrap=false]>div:last-child{white-space:pre}
.nodo-code-diff-native[data-diff]>div:last-child>div{position:relative;min-width:100%;width:max-content;margin:0;padding:1px 16px 1px 32px;box-shadow:none;line-height:22px;animation:nodo-code-diff-enter 220ms ease-out both;animation-delay:var(--nodo-diff-delay,900ms)}
.nodo-code-diff-native[data-diff][data-code-wrap=true]>div:last-child>div{width:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.nodo-code-diff-native[data-diff]>div:last-child>[class*="_path_"]{display:none}
.nodo-code-diff-native[data-diff]>div:last-child>[class*="_add_"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-label-primary)}
.nodo-code-diff-native[data-diff]>div:last-child>[class*="_del_"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-label-primary)}
.nodo-code-diff-native[data-diff]>div:last-child>[class*="_add_"]::before,.nodo-code-diff-native[data-diff]>div:last-child>[class*="_del_"]::before{position:absolute;left:12px;top:1px;width:12px;text-align:center}
.nodo-code-diff-native[data-diff]>div:last-child>[class*="_add_"]::before{content:'+';color:var(--dsw-alias-state-success-primary)}
.nodo-code-diff-native[data-diff]>div:last-child>[class*="_del_"]::before{content:'−';color:var(--dsw-alias-state-error-primary)}
.nodo-code-diff-native[data-diff]>div:last-child>[class*="_context_"],.nodo-code-diff-native[data-diff]>div:last-child>[class*="_gap_"]{color:var(--dsw-alias-label-secondary)}
.nodo-code-diff-native[data-diff]>div:last-child>[class*="_context_"]::before{content:none}
${Array.from({ length: 16 }, (_, index) => `.nodo-code-diff-native[data-diff]>div:last-child>div:nth-child(${index + 2}){--nodo-diff-delay:${index * 60}ms}`).join('\n')}
.nodo-code-diff-native[data-diff]>div:last-child>button{margin:4px 12px;color:var(--dsw-alias-label-tertiary)}
@keyframes nodo-code-diff-enter{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.nodo-code-diff-native[data-diff]>div:last-child>div,.nodo-code-diff-line{animation:none}}
`
