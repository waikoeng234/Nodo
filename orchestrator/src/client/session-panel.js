import { h, useState, useEffect, useMemo, useRef, useSyncExternalStore, call, Menu, rightPanelService, IconBranchOutlineRegular, IconFolderOpenOutlineRegular, IconChevronDownOutlineRegular, IconLinkOutlineRegular } from './ui-shared.js'
import { transcriptOf, watchTranscript, subscribeStore, getStoreVersion } from './live.js'
import { FileIcon } from './file-icons.tsx'
import { artifactsOf } from './artifacts.js'
import { changesBody, showChanges } from './stream-records.js'
import { Counts } from './file-changes-summary.tsx'
import { summarizeChanges } from './file-diffs.ts'
import { RoundTeam } from './round.js'

function Environment({ workspace, cwd, running }) {
  const [info, setInfo] = useState(null)
  const [branches, setBranches] = useState([])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const load = () => call('workspace-git', { workspace }).then(value => { setInfo(value); setError('') }).catch(failure => setError(failure.message))
  // Files change while the session runs and when another program edits them, so
  // the numbers refresh when a run starts or ends and when the window regains focus.
  useEffect(() => { void load() }, [workspace, running])
  useEffect(() => {
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [workspace])
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
      h('span', { className: 'nodo-env-counts', title: `${info.files} 个文件有改动` }, h(Counts, { value: { added: info.added, removed: info.removed } }))),
    error && h('p', { className: 'nodo-approval-error', role: 'alert' }, error))
}

// A team's artifacts gather every member's session; files group by the workspace they live in, so a member in its own worktree keeps its own diff.
function Artifacts({ sources, running }) {
  const [folded, setFolded] = useState(false)
  const [turnDiffs, setTurnDiffs] = useState({})
  useSyncExternalStore(subscribeStore, getStoreVersion)
  const key = sources.map(item => `${item.profile}:${item.session}`).join()
  useEffect(() => {
    const stops = sources.map(item => watchTranscript(item.profile, item.session))
    return () => stops.forEach(stop => stop())
  }, [key])
  const lists = sources.map(item => transcriptOf(`${item.profile}:${item.session}`))
  const gathered = useRef(null)
  if (gathered.current?.key !== key || lists.some((lines, index) => lines !== gathered.current.lists[index])) {
    const groups = new Map(), links = new Set(), images = new Map()
    sources.forEach((item, index) => {
      const found = artifactsOf(lists[index], item.cwd)
      const group = groups.get(item.workspace) ?? { workspace: item.workspace, cwd: item.cwd, files: new Map() }
      groups.set(item.workspace, group)
      for (const file of found.files) group.files.set(file.display, { ...file, diffs: [...group.files.get(file.display)?.diffs ?? [], ...file.diffs] })
      found.links.forEach(url => links.add(url))
      found.images.forEach(image => images.set(image.id, image))
    })
    gathered.current = { key, lists, links: [...links], images: [...images.values()], revision: lists.reduce((sum, lines) => sum + lines.length, 0),
      groups: [...groups.values()].map(group => ({ ...group, files: [...group.files.values()] })).filter(group => group.files.length > 0) }
  }
  const { groups, links, images, revision } = gathered.current
  const pathsKey = groups.map(group => `${group.workspace}\0${group.files.map(file => file.display).join('\0')}`).join('\n')
  // The right panel counts from git once opened, so the rows read the same diff.
  useEffect(() => {
    let live = true
    for (const group of groups) void call('workspace-diff', { workspace: group.workspace, paths: group.files.map(file => file.display) })
      .then(({ patch }) => { if (live) setTurnDiffs(current => ({ ...current, [group.workspace]: patch })) }).catch(() => {})
    return () => { live = false }
  }, [pathsKey, running])
  const shown = useMemo(() => groups.map(group => {
    const body = { ...changesBody(group.files, group.cwd), ...(turnDiffs[group.workspace] && { turnDiff: turnDiffs[group.workspace] }) }
    return { ...group, body, counts: summarizeChanges(body).files.map(item => item.counts) }
  }), [groups, turnDiffs])
  const fileCount = groups.reduce((sum, group) => sum + group.files.length, 0)
  if (fileCount + links.length + images.length === 0) return null
  const openChanges = (group, path) => showChanges(group.body, path, { cwd: group.cwd, revision, load: async () => {
    const { patch } = await call('workspace-diff', { workspace: group.workspace, paths: group.files.map(file => file.display) }).catch(() => ({ patch: '' }))
    return patch ? { ...group.body, turnDiff: patch } : group.body
  } })
  const reveal = () => { if (!rightPanelService.getSnapshot().expanded) rightPanelService.toggle() }
  const row = (key, icon, label, title, onClick, count) => h('button', { key, type: 'button', className: 'nodo-team-row', title, onClick },
    icon, h('span', { className: 'nodo-round-title' }, label), count && h('span', { className: 'nodo-env-counts' }, h(Counts, { value: count })))
  return h('div', { className: 'nodo-team nodo-artifacts' },
    h('button', { type: 'button', className: 'nodo-panel-head nodo-panel-fold', 'aria-expanded': !folded, onClick: () => setFolded(value => !value) },
      h('span', null, '产物'),
      h('span', { className: 'nodo-panel-meta' }, [fileCount && `${fileCount} 文件`, links.length && `${links.length} 链接`, images.length && `${images.length} 图片`].filter(Boolean).join(' · '),
        h(IconChevronDownOutlineRegular, { size: 14, style: folded ? { transform: 'rotate(-90deg)' } : undefined }))),
    !folded && h('div', { className: 'nodo-team-list' },
      ...shown.flatMap(group => group.files.map((file, index) => row(`f:${group.workspace}:${file.display}`, h(FileIcon, { name: file.name, size: 16 }), file.display,
        shown.length > 1 ? file.path : file.display, () => openChanges(group, file.path), group.counts[index]))),
      ...images.map(image => row(`i:${image.id}`, h(FileIcon, { name: image.name ?? 'image.png', size: 16 }), image.name ?? '图片', image.name ?? '图片',
        () => rightPanelService.openImage({ id: image.id, mediaType: image.mediaType, name: image.name }))),
      ...links.map(url => row(`l:${url}`, h(IconLinkOutlineRegular, { size: 16 }), url.replace(/^https?:\/\//, ''), url, () => { reveal(); rightPanelService.newBrowser(url) }))))
}

export function SessionPanel({ workspace, cwd, team, running, profile, session }) {
  return h('aside', { className: 'nodo-session-panel', 'aria-label': '摘要面板' },
    h(Environment, { key: `env:${workspace}`, workspace, cwd, running }),
    team && h(RoundTeam, { key: `team:${workspace}`, ...team, workspace }),
    session && h(Artifacts, { running, sources: (team ? [team.lead, ...team.members] : [{ role: { id: profile }, session: { id: session, cwd, workspaceRef: workspace } }])
      .map(item => ({ profile: item.role.id, session: item.session.id, cwd: item.session.cwd ?? cwd, workspace: item.session.workspaceRef ?? workspace })) }))
}
