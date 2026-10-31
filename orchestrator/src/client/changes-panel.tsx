import { h, Fragment, useEffect, useMemo, useState, Button, IconRightUpOutlineRegular, IconChevronLeftOutlineRegular } from './ui-shared.js'
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

export function ChangesView({ source, initialPath = '', openFile }: { source: ChangesSource; initialPath?: string; openFile: (path: string) => void }) {
  const [body, setBody] = useState(source.body)
  const [selected, setSelected] = useState(initialPath)
  const [busy, setBusy] = useState(!!source.load)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
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
  const current = files.find(({ file }) => file.path === selected)
  const row = (entry: typeof files[number], detail = false) => {
    const path = relativeFile(entry.file.path, body.cwd), slash = path.lastIndexOf('/') + 1
    const content = <>
      <FileIcon name={path} size={14} />
      <span className="nodo-changes-path" title={path}><span dir="ltr"><span className="nodo-changes-directory">{path.slice(0, slash)}</span><strong>{path.slice(slash)}</strong></span></span>
      <Counts value={entry.counts} />
    </>
    return <div key={entry.file.path} className="nodo-changes-row">
      {detail ? <div className="nodo-changes-row-title">{content}</div>
        : <button type="button" className="nodo-changes-row-title" aria-label={`查看 ${path} 的变更`} onClick={() => setSelected(entry.file.path)}>{content}</button>}
      <Button variant="ghost" aria-label={`打开文件 ${path}`} onClick={() => openFile(entry.file.path)} icon={<IconRightUpOutlineRegular size={16} />} />
    </div>
  }
  return <div className="nodo-right-changes" aria-busy={busy}>
    {selected ? <div className="nodo-changes-detail-head">
      <Button variant="ghost" aria-label="返回变更列表" onClick={() => setSelected('')} icon={<IconChevronLeftOutlineRegular size={16} />} />
      {current && row(current, true)}
    </div> : totals && <div className="nodo-changes-total"><span className="nodo-tag"><Counts value={totals} /></span></div>}
    {busy ? <p className="nodo-right-status" role="status">加载中…</p>
      : error ? <div className="nodo-changes-load-error"><p className="nodo-right-status" role="status">{error}</p><Button variant="outline" size="sm" onClick={() => setAttempt(value => value + 1)}>重试</Button></div>
        : selected ? current ? <div className="nodo-changes-diff" key={selected}>{source.renderFile(current.file, current.patch, true)}</div>
          : <p className="nodo-right-status" role="status">文件变更不可用</p>
          : <div className="nodo-changes-list">
            {files.map(entry => row(entry))}
            {files.length < body.fileCount && <p className="nodo-right-status" role="status">仅保存 {files.length} / {body.fileCount} 个文件</p>}
            {files.length === 0 && (body.turnDiff ? <CodeDiff filename="轮次差异" previewable={false} patch={body.turnDiff} cycle={source.revision} panel />
              : <p className="nodo-right-status" role="status">无文件变更</p>)}
          </div>}
  </div>
}

export const CHANGES_PANEL_CSS = `
.nodo-right-changes{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.nodo-changes-total{padding:12px 16px 8px}
.nodo-changes-total>.nodo-tag{display:inline-flex;align-items:center;height:28px;padding:0 12px;border-radius:var(--dsw-radius-full,999px)}
.nodo-changes-list,.nodo-changes-diff{flex:1;min-height:0;min-width:0;overflow-y:auto;overflow-x:hidden}
.nodo-changes-list{padding:0 8px 12px}
.nodo-changes-row{display:flex;align-items:center;gap:4px;min-width:0;border-radius:var(--dsw-radius-sm)}
.nodo-changes-list>.nodo-changes-row:hover,.nodo-changes-list>.nodo-changes-row:focus-within{background:var(--dsw-alias-interactive-bg-hover)}
.nodo-changes-row-title{display:flex;align-items:center;gap:8px;flex:1;min-width:0;min-height:36px;padding:4px 8px;border:0;border-radius:inherit;background:transparent;color:inherit;font:inherit;font-size:13px;text-align:left}
button.nodo-changes-row-title{cursor:pointer}
.nodo-changes-row-title>svg,.nodo-changes-row-title>img{flex:none;color:var(--dsw-alias-label-tertiary)}
.nodo-changes-path{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;direction:rtl;text-align:left}
.nodo-changes-directory{color:var(--dsw-alias-label-tertiary)}
.nodo-changes-path strong{font-weight:600}
.nodo-changes-detail-head{display:flex;align-items:center;gap:4px;flex:none;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.nodo-changes-detail-head>.nodo-changes-row{flex:1;min-width:0}
.nodo-changes-load-error{display:flex;align-items:center;gap:8px;padding-right:8px}
.nodo-changes-row-title:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.nodo-right-changes .nodo-note{padding:0 12px;overflow-wrap:anywhere}
`
