import { h, Fragment, useEffect, useMemo, useRef, useState, Button, IconRightUpOutlineRegular, IconChevronRightOutlineRegular, IconChevronDownOutlineRegular, IconSearchOutlineRegular } from './ui-shared.js'
import type { ReactNode } from './ui-shared.js'
import { FileIcon } from './file-icons.tsx'
import { Counts } from './file-changes-summary.tsx'
import { CodeDiff } from './code-diff.tsx'
import { relativeFile, summarizeChanges } from './file-diffs.ts'
import type { ChangedFileData, ChangesBody } from './file-diffs.ts'

export interface ChangesSource {
  body: ChangesBody
  revision: number
  load?: () => Promise<ChangesBody>
  renderFile: (file: ChangedFileData, patch?: string, panel?: boolean) => ReactNode
}

type Entry = ReturnType<typeof summarizeChanges>['files'][number]
type Dir = { dirs: Map<string, Dir>; files: { name: string; path: string; entry: Entry }[] }
const treeOf = (entries: { rel: string; entry: Entry }[]) => {
  const root: Dir = { dirs: new Map(), files: [] }
  for (const { rel, entry } of entries) {
    const parts = rel.split('/')
    let at = root
    for (const part of parts.slice(0, -1)) {
      if (!at.dirs.has(part)) at.dirs.set(part, { dirs: new Map(), files: [] })
      at = at.dirs.get(part)!
    }
    at.files.push({ name: parts.at(-1)!, path: entry.file.path, entry })
  }
  return root
}

export function ChangesView({ source, initialPath = '', openFile }: { source: ChangesSource; initialPath?: string; openFile: (path: string) => void }) {
  const [body, setBody] = useState(source.body)
  const [selected, setSelected] = useState(initialPath)
  const [query, setQuery] = useState('')
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(!!source.load)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const sections = useRef<Record<string, HTMLElement | null>>({})
  useEffect(() => {
    if (!source.load) return
    let live = true
    setBusy(true); setError('')
    void source.load().then(value => { if (live) setBody(value) })
      .catch(failure => { if (live) setError(failure.message || '变更详情读取失败') })
      .finally(() => { if (live) setBusy(false) })
    return () => { live = false }
  }, [source, attempt])
  const { files, totals } = useMemo(() => summarizeChanges(body), [body])
  useEffect(() => { if (selected && !busy) sections.current[selected]?.scrollIntoView?.({ block: 'start' }) }, [selected, busy])
  const rows = files.map(entry => ({ rel: relativeFile(entry.file.path, body.cwd), entry }))
  const wanted = query.trim().toLowerCase()
  const tree = treeOf(rows.filter(({ rel }) => !wanted || rel.toLowerCase().includes(wanted)))
  const branch = (dir: Dir, prefix: string, depth: number): ReactNode => <>
    {[...dir.dirs].map(([name, child]) => {
      const key = `${prefix}${name}/`
      return <div key={key}>
        <button type="button" className="nodo-changes-node" style={{ paddingInlineStart: 8 + depth * 14 }} aria-expanded={!folded[key]}
          onClick={() => setFolded(current => ({ ...current, [key]: !current[key] }))}>
          {folded[key] ? <IconChevronRightOutlineRegular size={12} /> : <IconChevronDownOutlineRegular size={12} />}<span>{name}</span>
        </button>
        {!folded[key] && branch(child, key, depth + 1)}
      </div>
    })}
    {dir.files.map(file => <button key={file.path} type="button" className="nodo-changes-node" data-selected={file.path === selected || undefined}
      style={{ paddingInlineStart: 8 + depth * 14 }} title={relativeFile(file.path, body.cwd)} onClick={() => setSelected(file.path)}>
      <FileIcon name={file.name} size={14} /><span>{file.name}</span><Counts value={file.entry.counts} />
    </button>)}
  </>
  const section = ({ rel, entry }: { rel: string; entry: Entry }) => {
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    return <section key={entry.file.path} className="nodo-changes-file-section" ref={element => { sections.current[entry.file.path] = element }}>
      <header className="nodo-changes-row-title">
        <FileIcon name={name} size={14} />
        <span className="nodo-changes-path" title={rel}><strong>{name}</strong></span>
        <Counts value={entry.counts} />
        <Button variant="ghost" aria-label={`打开文件 ${rel}`} onClick={() => openFile(entry.file.path)} icon={<IconRightUpOutlineRegular size={16} />} />
      </header>
      <div className="nodo-changes-diff">{source.renderFile(entry.file, entry.patch, true)}</div>
    </section>
  }
  const message = (text: ReactNode) => <p className="nodo-right-status" role="status">{text}</p>
  return <div className="nodo-right-changes" aria-busy={busy}>
    <div className="nodo-changes-viewer">
      {busy ? message('加载中…')
        : error ? <div className="nodo-changes-load-error">{message(error)}<Button variant="outline" size="sm" onClick={() => setAttempt(value => value + 1)}>重试</Button></div>
          : <>
            {rows.map(section)}
            {files.length < body.fileCount && message(`仅保存 ${files.length} / ${body.fileCount} 个文件`)}
            {files.length === 0 && (body.turnDiff ? <CodeDiff filename="轮次差异" previewable={false} patch={body.turnDiff} cycle={source.revision} panel />
              : message('无文件变更'))}
          </>}
    </div>
    {files.length > 0 && <div className="nodo-changes-tree">
      <label className="nodo-right-filter"><IconSearchOutlineRegular size={14} />
        <input type="text" aria-label="筛选文件" placeholder="筛选文件" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="nodo-changes-tree-head"><span>已更改的文件</span>{totals && <Counts value={totals} />}</div>
      <div className="nodo-changes-nodes">{branch(tree, '', 0)}</div>
    </div>}
  </div>
}

export const CHANGES_PANEL_CSS = `
.nodo-right-changes{display:flex;flex:1;flex-direction:row;min-width:0;min-height:0;overflow:hidden}
.nodo-changes-viewer{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;overflow-y:auto;overflow-x:hidden}
.nodo-changes-file-section{flex:none;min-width:0}
.nodo-changes-diff{min-width:0;overflow-x:hidden}
.nodo-changes-tree{display:flex;flex:0 0 min(280px,45%);flex-direction:column;min-width:0;min-height:0;border-left:.5px solid var(--dsw-alias-border-l3)}
.nodo-changes-tree-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;padding:10px 16px 4px;color:var(--dsw-alias-label-secondary);font-size:13px}
.nodo-changes-nodes{display:flex;flex-direction:column;gap:2px;flex:1;min-height:0;overflow-y:auto;padding:0 8px 12px}
.nodo-changes-node{display:flex;align-items:center;gap:6px;width:100%;min-height:30px;padding:4px 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer}
.nodo-changes-node:hover,.nodo-changes-node[data-selected]{background:var(--dsw-alias-interactive-bg-hover)}
.nodo-changes-node>svg,.nodo-changes-node>img{flex:none;color:var(--dsw-alias-label-tertiary)}
.nodo-changes-node>span:not(.nodo-changes-counts){flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-changes-row-title{display:flex;align-items:center;gap:8px;min-width:0;min-height:36px;padding:4px 8px 4px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);font-size:13px}
.nodo-changes-row-title>svg,.nodo-changes-row-title>img{flex:none;color:var(--dsw-alias-label-tertiary)}
.nodo-changes-path{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.nodo-changes-path strong{font-weight:600}
.nodo-changes-load-error{display:flex;align-items:center;gap:8px;padding-right:8px}
.nodo-changes-node:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.nodo-right-changes .nodo-note{padding:0 12px;overflow-wrap:anywhere}
`
