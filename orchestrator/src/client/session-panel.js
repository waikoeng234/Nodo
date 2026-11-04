import { h, useState, useEffect, useMemo, useSyncExternalStore, call, Menu, rightPanelService, IconBranchOutlineRegular, IconFolderOpenOutlineRegular, IconChevronDownOutlineRegular, IconLinkOutlineRegular } from './ui-shared.js'
import { transcriptOf, watchTranscript, subscribeStore, getStoreVersion } from './live.js'
import { FileIcon } from './file-icons.tsx'
import { artifactsOf } from './artifacts.js'
import { ChangedFile } from './stream-records.js'
import { Counts } from './file-changes-summary.tsx'
import { RoundTeam } from './round.js'

function Environment({ workspace, cwd, struct }) {
  const [info, setInfo] = useState(null)
  const [branches, setBranches] = useState([])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    call('workspace-git', { workspace }).then(value => { if (live) { setInfo(value); setError('') } }).catch(failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [workspace, struct])
  useEffect(() => {
    if (open) void call('worktree-refs', { workspace }).then(value => setBranches(value.branches)).catch(() => setBranches([]))
  }, [open])
  const switchTo = name => {
    setOpen(false)
    setError('')
    call('workspace-switch', { workspace, branch: name }).then(setInfo).catch(failure => setError(failure.message))
  }
  const path = info?.cwd ?? cwd
  return h('div', { className: 'nodo-env' },
    h('div', { className: 'nodo-panel-head' }, h('span', null, '本机环境')),
    h('div', { className: 'nodo-env-row', title: path }, h(IconFolderOpenOutlineRegular, { size: 16 }), h('span', { className: 'nodo-env-text' }, path)),
    info?.git && h('div', { className: 'nodo-env-row' },
      h(Menu, {
        open, onClose: () => setOpen(false), portal: true, align: 'start', selectedId: info.head.name,
        items: branches.map(branch => ({ id: branch.name, label: branch.name, disabled: branch.checkedOutAt !== undefined && branch.name !== info.head.name })),
        onSelect: switchTo,
        anchor: h('button', { type: 'button', className: 'nodo-env-branch', 'aria-haspopup': 'menu', 'aria-expanded': open, title: '切换分支', onClick: () => setOpen(value => !value) },
          h(IconBranchOutlineRegular, { size: 16 }), h('span', { className: 'nodo-env-text' }, info.head.name ?? `${info.head.commit ?? ''}（游离）`), h(IconChevronDownOutlineRegular, { size: 14 })),
      }),
      h('span', { className: 'nodo-env-counts', title: `${info.files} 个已跟踪文件有改动` }, h(Counts, { value: { added: info.added, removed: info.removed } }))),
    error && h('p', { className: 'nodo-approval-error', role: 'alert' }, error))
}

function Artifacts({ workspace, profile, session, cwd }) {
  const [folded, setFolded] = useState(false)
  useSyncExternalStore(subscribeStore, getStoreVersion)
  useEffect(() => watchTranscript(profile, session), [profile, session])
  const lines = transcriptOf(`${profile}:${session}`)
  const { files, links, images } = useMemo(() => artifactsOf(lines, cwd), [lines, cwd])
  if (files.length + links.length + images.length === 0) return null
  const openChanges = path => {
    const body = { scope: 'edit-tools', coverage: 'partial', cwd, fileCount: files.length, files: files.map(file => ({ path: file.path, edits: file.diffs.map(diff => ({
      operation: diff.oldText == null && diff.patch === undefined ? 'add' : 'update', oldText: diff.oldText ?? null, newText: diff.newText, ...(diff.patch ? { diffText: diff.patch } : {}) })) })) }
    rightPanelService.openChanges({ revision: lines.length, body,
      renderFile: (file, patch, panel) => h(ChangedFile, { key: file.path, file, patch, panel, inline: true, root: cwd, cycle: lines.length }),
      load: async () => {
        const { patch } = await call('workspace-diff', { workspace, paths: files.map(file => file.display) }).catch(() => ({ patch: '' }))
        return patch ? { ...body, turnDiff: patch } : body
      } }, path)
  }
  const reveal = () => { if (!rightPanelService.getSnapshot().expanded) rightPanelService.toggle() }
  const row = (key, icon, label, title, onClick) => h('button', { key, type: 'button', className: 'nodo-team-row', title, onClick },
    icon, h('span', { className: 'nodo-round-title' }, label))
  return h('div', { className: 'nodo-team nodo-artifacts' },
    h('button', { type: 'button', className: 'nodo-panel-head nodo-panel-fold', 'aria-expanded': !folded, onClick: () => setFolded(value => !value) },
      h('span', null, '产物'),
      h('span', { className: 'nodo-panel-meta' }, [files.length && `${files.length} 文件`, links.length && `${links.length} 链接`, images.length && `${images.length} 图片`].filter(Boolean).join(' · '),
        h(IconChevronDownOutlineRegular, { size: 14, style: folded ? { transform: 'rotate(-90deg)' } : undefined }))),
    !folded && h('div', { className: 'nodo-team-list' },
      ...files.map(file => row(`f:${file.display}`, h(FileIcon, { name: file.name, size: 16 }), file.display, file.display, () => openChanges(file.path))),
      ...images.map(image => row(`i:${image.id}`, h(FileIcon, { name: image.name ?? 'image.png', size: 16 }), image.name ?? '图片', image.name ?? '图片',
        () => rightPanelService.openImage({ id: image.id, mediaType: image.mediaType, name: image.name }))),
      ...links.map(url => row(`l:${url}`, h(IconLinkOutlineRegular, { size: 16 }), url.replace(/^https?:\/\//, ''), url, () => { reveal(); rightPanelService.newBrowser(url) }))))
}

export function SessionPanel({ workspace, cwd, team, struct, profile, session }) {
  return h('aside', { className: 'nodo-session-panel', 'aria-label': '摘要面板' },
    h(Environment, { key: workspace, workspace, cwd, struct }),
    team && h(RoundTeam, { key: workspace, ...team, struct, workspace }),
    session && h(Artifacts, { workspace, profile, session, cwd }))
}
