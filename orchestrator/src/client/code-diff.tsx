import { h, useEffect, useMemo, useState, useSyncExternalStore, CodeBlock, DiffBlock, diffTotals, writeClipboard, IconCompareSplitOutlineRegular, rightPanelService } from './ui-shared.js'
import { parsedPatch, patchCounts } from './file-diffs.ts'
import { structuredPatch, diffWordsWithSpace } from 'diff'
import type { Change, StructuredPatch } from 'diff'

export interface FileDiff { path: string; oldText: string | null; newText: string }
export interface CodeDiffProps {
  filename: string
  previewable?: boolean
  diff?: FileDiff
  patch?: string
  cycle?: string | number
  panel?: boolean
  preview?: boolean
}

const LABELS = { copy: '复制', copied: '已复制', collapseAria: '收起差异', expandAria: (n: number) => `展开其余 ${n} 行`,
  collapse: '收起', expand: (n: number) => `展开其余 ${n} 行` }
const PREVIEW_LINES = 200
const subscribePanel = (listener: () => void) => rightPanelService?.subscribe(listener) ?? (() => {})
const panelTarget = () => rightPanelService?.getSnapshot().target ?? null

export function CodeDiff({ filename, previewable = true, diff, patch, cycle = 0, panel = false, preview = false }: CodeDiffProps) {
  const target = useSyncExternalStore(subscribePanel, panelTarget)
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
  if (panel) return <PanelDiff key={`${filename}:${cycle}`} filename={filename} diff={diff} patch={patch} />
  return (
    <div className="nodo-code-diff" data-slot="code-diff">
      <div className="nodo-code-diff-header">
        <span className="nodo-code-diff-icon" aria-hidden><IconCompareSplitOutlineRegular size={14} /></span>
        {target && previewable ? <button type="button" className="nodo-code-diff-filename" title={filename} aria-label={`预览文件 ${filename}${fragment ? ' · 替换片段' : ''}`}
          onClick={() => rightPanelService?.openFile(filename)}>{filename}{fragment ? ' · 替换片段' : ''}</button>
          : <span className="nodo-code-diff-filename" title={filename}>{filename}{fragment ? ' · 替换片段' : ''}</span>}
        {totals && <span className="nodo-code-diff-counts" aria-label={`新增 ${totals.added} 行，删除 ${totals.removed} 行`}>
          <span className="nodo-code-diff-added">+{totals.added}</span>
          <span className="nodo-code-diff-removed">−{totals.removed}</span>
        </span>}
        {parsed && <button type="button" className="nodo-code-diff-copy" onClick={async () => {
          if (patch !== undefined && await writeClipboard(patch)) setCopied(true)
        }}>{copied ? LABELS.copied : LABELS.copy}</button>}
      </div>
      {preview ? <PanelDiff key={`${filename}:${cycle}`} filename={filename} diff={diff} patch={patch} />
        : diff ? <DiffBlock key={cycle} className="nodo-code-diff-native" diffs={diffs} labels={LABELS} />
        : lines ? <pre className="nodo-code-diff-patch" tabIndex={0} aria-label={`${filename} 差异`}>
          <code>{(expanded ? lines : lines.slice(0, PREVIEW_LINES)).map((line, index) => <span key={`${cycle}:${index}`} className="nodo-code-diff-line" data-kind={line.kind}
            style={{ animationDelay: `${Math.min(index * 60, 900)}ms` }}>{line.text}</span>)}</code>
        </pre> : <CodeBlock key={cycle} className="nodo-code-diff-native" code={patch} lang="diff" copyLabel={LABELS.copy} copiedLabel={LABELS.copied} />}
      {!preview && lines && lines.length > PREVIEW_LINES && <button type="button" className="nodo-code-diff-expand" aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}>{expanded ? LABELS.collapse : LABELS.expand(lines.length - PREVIEW_LINES)}</button>}
    </div>
  )
}

type NumberedLine = { kind: string; text: string; old?: number; next?: number; parts?: Change[]; filename?: string }
type DiffSection = { lines: NumberedLine[]; hidden?: number; filename?: string }

function numberedSections(patches: StructuredPatch[]): DiffSection[] {
  const sections: DiffSection[] = []
  for (const patch of patches) {
    if (patches.length > 1) sections.push({ lines: [], filename: (patch.newFileName === '/dev/null' ? patch.oldFileName : patch.newFileName)?.replace(/^[ab]\//, '') ?? '未知文件' })
    let oldEnd = 0, newEnd = 0
    for (const hunk of patch.hunks) {
      if (patches.length > 1 && hunk === patch.hunks[0]) { oldEnd = hunk.oldStart - 1; newEnd = hunk.newStart - 1 }
      const oldGap = hunk.oldStart - oldEnd - 1, newGap = hunk.newStart - newEnd - 1
      if (oldGap > 0 && oldGap === newGap) sections.push({ lines: [], hidden: oldGap })
      else if (oldGap > 0 || newGap > 0) sections.push({ lines: [{ kind: 'meta', text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` }] })
      let old = hunk.oldStart, next = hunk.newStart
      const rows = hunk.lines.map(text => {
        const kind = text.startsWith('+') ? 'added' : text.startsWith('-') ? 'removed' : text.startsWith('\\') ? 'meta' : 'context'
        return { kind, text: kind === 'meta' ? text : text.slice(1), filename: patch.newFileName === '/dev/null' ? patch.oldFileName : patch.newFileName,
          old: kind === 'removed' || kind === 'context' ? old++ : undefined,
          next: kind === 'added' || kind === 'context' ? next++ : undefined } satisfies NumberedLine
      })
      oldEnd = old - 1; newEnd = next - 1
      for (let at = 0; at < rows.length;) {
        const kind = rows[at].kind
        let end = at + 1
        while (end < rows.length && rows[end].kind === kind) end++
        if (kind === 'context' && end - at > 6) {
          sections.push({ lines: rows.slice(at, at + 3) }, { lines: rows.slice(at + 3, end - 3), hidden: end - at - 6 }, { lines: rows.slice(end - 3, end) })
        } else sections.push({ lines: rows.slice(at, end) })
        at = end
      }
    }
  }
  for (let index = 0; index < sections.length - 1; index++) {
    let next = index + 1
    while (next < sections.length && sections[next].lines.length && sections[next].lines.every(line => line.kind === 'meta' && line.text.startsWith('\\'))) next++
    const before = sections[index].lines, after = sections[next]?.lines ?? []
    if (before[0]?.kind !== 'removed' || after[0]?.kind !== 'added') continue
    before.forEach((line, index) => {
      const added = after[index]
      if (!added) return
      const parts = diffWordsWithSpace(line.text, added.text, { timeout: 40, maxEditLength: 1000 })
      if (parts) { line.parts = parts.filter(part => !part.added); added.parts = parts.filter(part => !part.removed) }
    })
  }
  return sections
}

function PanelDiff({ filename, diff, patch }: CodeDiffProps) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})
  const patches = useMemo(() => diff ? [structuredPatch(filename, filename, diff.oldText ?? '', diff.newText, '', '', { context: Infinity, timeout: 40, maxEditLength: 10000 })].filter((patch): patch is StructuredPatch => !!patch)
    : parsedPatch(patch ?? '') ?? [], [filename, diff, patch])
  const sections = useMemo(() => numberedSections(patches), [patches])
  if (!patches.length) return diff ? <DiffBlock diffs={[diff]} labels={LABELS} />
    : <div className="nodo-panel-diff"><p className="nodo-note">无法解析差异，以下为原始内容</p><CodeBlock code={patch ?? ''} lang="diff" wrap lineNumbers showHeader={false} /></div>
  return <div className="nodo-panel-diff">
    {patches.some(patch => patch.oldHeader === 'Nodo replacement fragment') && <p className="nodo-note">替换片段 · 行号相对片段</p>}
    <div className="nodo-panel-diff-patch" tabIndex={0} role="region" aria-label={`${filename} 差异`}>
      {sections.map((section, index) => section.filename ? <span key={index} className="nodo-panel-diff-filename">{section.filename}</span> : section.hidden && !expanded[index]
        ? section.lines.length ? <button type="button" key={index} className="nodo-panel-diff-gap" aria-expanded={false}
          onClick={() => setExpanded(value => ({ ...value, [index]: true }))}>{section.hidden} 行未修改</button>
          : <span key={index} className="nodo-panel-diff-gap">{section.hidden} 行未修改</span>
        : section.lines.map((line, at) => <div key={`${index}:${at}`} className="nodo-panel-diff-line" data-kind={line.kind}>
          <span className="nodo-panel-diff-number" aria-hidden>{line.kind === 'removed' ? line.old : line.next}</span>
          <div className="nodo-panel-diff-text">
            <CodeBlock className="nodo-panel-diff-code" code={line.text} lang={line.kind === 'meta' ? 'text' : (line.filename ?? filename).split('.').at(-1)?.toLowerCase()} wrap showHeader={false} />
            {line.parts && <span className="nodo-panel-diff-words" aria-hidden>{line.parts.map((part, index) => part.added || part.removed ? <mark key={index}>{part.value}</mark> : part.value)}</span>}
          </div>
        </div>))}
    </div>
  </div>
}

// DiffBlock owns parsing, copying, wrapping and collapsed context. Its semantic
// CSS module names let this skin follow those rows without pinning their hashes.
export const CODE_DIFF_CSS = `
.nodo-code-diff{position:relative;min-width:0;max-width:100%;margin:6px 0;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);overflow:hidden;background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-primary)}
.nodo-code-diff-header{display:flex;align-items:center;gap:8px;min-height:36px;min-width:0;padding:6px 84px 6px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);font:var(--dsw-font-markdown-code-block-small)}
.nodo-code-diff-icon{display:flex;flex:none;color:var(--dsw-alias-label-tertiary)}
.nodo-code-diff-filename{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button.nodo-code-diff-filename{padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:start;cursor:pointer}
button.nodo-code-diff-filename:hover{text-decoration:underline}
button.nodo-code-diff-filename:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary)}
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
.nodo-panel-diff{min-width:0;max-width:100%;color:var(--dsw-alias-label-primary)}
.nodo-panel-diff *{box-sizing:border-box}
.nodo-panel-diff-patch{margin:0;padding:8px 0;white-space:normal;font:var(--dsw-font-markdown-code-block-small);tab-size:4}
.nodo-panel-diff-filename{display:block;padding:8px 12px;font-weight:600;background:var(--dsw-alias-bg-layer-1)}
.nodo-panel-diff-line{display:grid;grid-template-columns:calc(4ch + 20px) minmax(0,1fr);min-height:22px;line-height:22px}
.nodo-panel-diff-number{text-align:right;padding:0 10px 0 6px;border-left:3px solid var(--nodo-line-tone,transparent);border-right:2px solid var(--dsw-alias-bg-base);color:var(--nodo-line-tone,var(--dsw-alias-label-secondary));user-select:none}
.nodo-panel-diff-text{position:relative;min-width:0;min-height:22px;padding:0 12px;white-space:pre-wrap;overflow-wrap:anywhere}
.nodo-panel-diff-code{margin:0!important;padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;font:inherit!important}
.nodo-panel-diff-code [data-code-block-content]{padding:0;overflow:visible}
.nodo-panel-diff-code pre,.nodo-panel-diff-code code{margin:0!important;padding:0!important;background:transparent!important;font:inherit!important;white-space:pre-wrap!important;overflow-wrap:anywhere!important;overflow:visible!important}
.nodo-panel-diff-words{position:absolute;inset:0;padding:0 12px;color:transparent;pointer-events:none;user-select:none;white-space:pre-wrap;overflow-wrap:anywhere}
.nodo-panel-diff-line[data-kind=added]{--nodo-line-tone:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--nodo-line-tone) 10%,transparent)}
.nodo-panel-diff-line[data-kind=removed]{--nodo-line-tone:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--nodo-line-tone) 10%,transparent)}
.nodo-panel-diff-words mark{color:transparent;background:color-mix(in srgb,var(--nodo-line-tone) 25%,transparent)}
.nodo-panel-diff-line[data-kind=meta]{color:var(--dsw-alias-label-tertiary)}
.nodo-panel-diff-gap{display:block;width:100%;padding:8px 12px;border:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;text-align:left;white-space:normal}
button.nodo-panel-diff-gap{cursor:pointer}
button.nodo-panel-diff-gap:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
`
