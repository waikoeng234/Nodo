import { h, Fragment, IconChevronDownOutlineRegular, IconFolderOpenOutlineRegular } from './ui-shared.js'
import type { ComponentProps, ReactNode } from 'react'

export interface FileTreeNode {
  path: string
  name: string
  depth: number
  kind: 'folder' | 'file'
  additions?: number
  deletions?: number
}

export function buildFileTree(files: readonly { path: string; relativePath?: string; additions?: number; deletions?: number }[]): FileTreeNode[] {
  const groups = new Map<string, FileTreeNode[]>()
  for (const file of files) {
    const path = file.relativePath ?? file.path
    const slash = path.lastIndexOf('/')
    const directory = slash < 0 ? '' : path.slice(0, slash) || '/'
    if (!groups.has(directory)) groups.set(directory, [])
    groups.get(directory)!.push({ path: file.path, name: path.slice(slash + 1), depth: directory ? 1 : 0, kind: 'file',
      additions: file.additions, deletions: file.deletions })
  }
  return Array.from(groups, ([directory, files]) => directory
    ? [{ path: directory, name: directory, depth: 0, kind: 'folder' as const }, ...files] : files).flat()
}

export function FileTree({ nodes, visibleCount = nodes.length, totalAdditions, totalDeletions, header, renderFile, className = '', ...props }:
  Omit<ComponentProps<'div'>, 'children'> & {
    nodes: readonly FileTreeNode[]
    visibleCount?: number
    totalAdditions?: number
    totalDeletions?: number
    header?: ReactNode
    renderFile?: (node: FileTreeNode, content: ReactNode) => ReactNode
  }) {
  return <div data-slot="file-tree" className={`nodo-file-tree ${className}`} {...props}>
    {header ?? <div className="nodo-file-tree-header">
      <span>{nodes.filter(node => node.kind === 'file').length} 个文件变更</span>
      <span className="nodo-file-tree-counts">
        {totalAdditions !== undefined && <span className="nodo-file-tree-added">+{totalAdditions.toLocaleString()}</span>}
        {totalDeletions !== undefined && <span className="nodo-file-tree-removed">−{totalDeletions.toLocaleString()}</span>}
      </span>
    </div>}
    {nodes.slice(0, Math.max(0, visibleCount)).map(node => {
      const content = <span className="nodo-file-tree-row" style={{ paddingInlineStart: `${4 + node.depth * 14}px` }}>
        {node.kind === 'folder' ? <><IconChevronDownOutlineRegular size={12} /><IconFolderOpenOutlineRegular size={14} /></>
          : <span className="nodo-file-tree-icon" aria-hidden />}
        <span className="nodo-file-tree-name" title={node.path}>{node.name}</span>
        {node.kind === 'file' && <span className="nodo-file-tree-counts">
          {!!node.additions && <span className="nodo-file-tree-added">+{node.additions.toLocaleString()}</span>}
          {!!node.deletions && <span className="nodo-file-tree-removed">−{node.deletions.toLocaleString()}</span>}
        </span>}
      </span>
      return <div key={`${node.kind}:${node.path}`} data-kind={node.kind} className="nodo-file-tree-entry">
        {node.kind === 'file' && renderFile ? renderFile(node, content) : content}
      </div>
    })}
  </div>
}

export const FILE_TREE_CSS = `
.nodo-file-tree{min-width:0;padding:8px 12px}
.nodo-file-tree-header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:4px;font-size:13px;font-weight:500}
.nodo-file-tree-entry{min-width:0}
.nodo-file-tree-row{display:flex;align-items:center;gap:8px;min-width:0;min-height:30px;padding-block:5px;padding-inline-end:4px;border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.nodo-file-tree-row>svg{flex:none;color:var(--dsw-alias-label-tertiary)}
.nodo-file-tree-entry[data-kind=folder]>.nodo-file-tree-row{color:var(--dsw-alias-label-secondary)}
.nodo-file-tree-icon{display:flex;flex:none;width:14px;margin-inline-start:12px;color:var(--dsw-alias-label-tertiary)}
.nodo-file-tree-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-file-tree-counts{display:inline-flex;flex:none;gap:6px;font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.nodo-file-tree-added{color:var(--dsw-alias-state-success-primary)}
.nodo-file-tree-removed{color:var(--dsw-alias-state-error-primary)}
`
