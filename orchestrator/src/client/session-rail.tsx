import type { ReactNode } from './ui-shared.js'
import {
  h, Fragment, useState, Menu, Tooltip, Button, Input, StateDot, Tag, workLabel, workDot,
  sessionTime, workspaceIdOf, roleStateOf, ARCHIVED_VIEWS, SESSION_FOLD, layoutService,
  IconArchiveOutlineRegular, IconArchiveOffOutlineRegular, IconBranchOutlineRegular, IconChevronDownOutlineRegular,
  IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconEditOutlineRegular, IconEllipsisOutlineRegular,
  IconFlatListOutlineRegular, IconFolderOpenOutlineRegular,
  IconNewChatOutlineRegular, IconPinFillRegular, IconPinOutlineRegular, IconPlusOutlineRegular,
  IconProjectAddOutlineRegular, IconSearchOutlineRegular, IconSettingsOutlineRegular,
  IconTrashOutlineRegular, IconUsersOutlineRegular, IconWorkspaceTreeOutlineRegular,
} from './ui-shared.js'
import { RoleAvatar } from './avatar.tsx'

export interface RailSession { id: string; name: string; archivedAt?: number; pinnedAt?: number; updatedAt?: number; engine?: string; workspaceRef?: string; cwd?: string }
export interface RailRole { id: string; name: string; role?: string; instructions?: string; engine?: string; avatarTemplate?: string; workspaceId?: string; sessions: RailSession[] }
export interface RailWorkspace { id: string; name: string; cwd: string; createdAt?: number; worktree?: { branch: string } }
export interface RailView { profiles: RailRole[]; workspaces: RailWorkspace[]; work: Record<string, { active?: boolean } | undefined> }
type Archived = keyof typeof ARCHIVED_VIEWS

interface SessionRowProps {
  role: RailRole; session: RailSession; current: boolean; work?: { active?: boolean }; busy?: boolean
  onSelect: () => void; onArchive: (archived: boolean) => void; onRename: () => void; onPin: (pinned: boolean) => void
}

// One session row: the host row's title and meta, an archive button and a menu
// for rename and pin. Archive is refused while the session runs; an archived row
// cannot be opened until it is unarchived, the host sidebar's rule.
export function SessionRow({ role, session, current, work, busy, onSelect, onArchive, onRename, onPin }: SessionRowProps) {
  const [open, setOpen] = useState(false)
  const archived = !!session.archivedAt
  const pinned = !!session.pinnedAt
  const running = work?.active === true
  const status = workLabel(work)
  return (
    <div className="nodo-session-item" data-menu={open ? 'open' : undefined}>
      <button type="button" className="nodo-row nodo-session" disabled={busy || archived} data-archived={archived ? '' : undefined}
        aria-current={current ? 'page' : undefined} aria-description={archived ? '已归档会话暂时无法查看，请取消归档后查看' : undefined}
        onClick={onSelect} title={`${role.name} · ${session.name}`}>
        <RoleAvatar profile={role} size={18} />
        <span className="nodo-row-title">{session.name}</span>
        <span className="nodo-row-meta">{archived
          ? <span className="nodo-row-archived"><IconArchiveOutlineRegular size={12} />已归档</span>
          : status
            ? <span className="nodo-row-running" title={status}><StateDot state={workDot(work)} size={12} />{status}</span>
            : <Fragment>{pinned && <IconPinFillRegular size={12} />}{sessionTime(session.updatedAt)}</Fragment>}</span>
      </button>
      <span className="nodo-row-actions">
        <button type="button" className="nodo-row-action" disabled={busy || running}
          aria-label={archived ? `取消归档会话“${session.name}”` : `归档会话“${session.name}”`} title={archived ? '取消归档' : '归档会话'}
          onClick={event => { event.stopPropagation(); onArchive(!archived) }}>
          {archived ? <IconArchiveOffOutlineRegular /> : <IconArchiveOutlineRegular />}
        </button>
        <Menu open={open} onClose={() => setOpen(false)} portal closeOnPointerLeave
          items={[
            { id: 'rename', label: '修改会话名称', icon: <IconEditOutlineRegular />, disabled: busy },
            { id: 'pin', label: pinned ? '取消置顶' : '置顶会话', icon: pinned ? <IconPinFillRegular /> : <IconPinOutlineRegular />, disabled: busy || archived },
          ]}
          onSelect={(id: string) => { setOpen(false); if (id === 'rename') onRename(); else onPin(!pinned) }}
          anchor={<button type="button" className="nodo-row-action" aria-haspopup="menu" aria-expanded={open}
            aria-label={`会话“${session.name}”的更多操作`} disabled={busy}
            onClick={event => { event.stopPropagation(); setOpen(current => !current) }}><IconEllipsisOutlineRegular /></button>} />
      </span>
    </div>
  )
}

interface PickerOptions {
  workspaces: RailWorkspace[]; workspace?: RailWorkspace | null; running?: Set<string>; open: boolean
  setOpen: (update: (open: boolean) => boolean) => void; onSelect: (id: string) => void
  none?: string; button?: boolean; label?: string; disabled?: boolean
}

// The project picker of the rail, also used by the workflow canvas. `none` adds a
// first item for no workspace; `button` draws the anchor as a small outline button.
export const workspacePicker = ({ workspaces, workspace, running = new Set(), open, setOpen, onSelect, none, button = false, label = '选择项目', disabled }: PickerOptions) => {
  const ordered = [...workspaces].reverse().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  const othersRunning = ordered.some(item => item.id !== workspace?.id && running.has(item.id))
  const name = workspace?.name ?? none
  const Glyph = workspace ? workspace.worktree ? IconBranchOutlineRegular : IconFolderOpenOutlineRegular : IconUsersOutlineRegular
  const anchor = <Fragment>
    <span className="nodo-folder"><Glyph size={16} /></span>
    <span className="nodo-row-title">{name}</span>
    {othersRunning && <span className="nodo-project-state" title="其他项目或分支有正在运行的任务"><StateDot state="ongoing" size={12} /></span>}
    <span className="nodo-chevron" data-open={open ? '' : undefined}><IconChevronDownOutlineRegular size={14} /></span>
  </Fragment>
  const props = { disabled, 'aria-haspopup': 'menu' as const, 'aria-expanded': open, 'aria-label': `${label}，当前 ${name}`,
    title: workspace ? workspace.worktree ? `${workspace.worktree.branch} · ${workspace.cwd}` : workspace.cwd : undefined,
    onClick: (event: { stopPropagation(): void }) => { event.stopPropagation(); setOpen(value => !value) } }
  return (
    <Menu open={open} onClose={() => setOpen(() => false)} portal selectedId={workspace?.id ?? ''} align="start" className="nodo-picker"
      items={[...(none ? [{ id: '', label: none, icon: <IconUsersOutlineRegular /> }] : []), ...ordered.map(item => ({ id: item.id,
        label: running.has(item.id)
          ? <span className="nodo-menu-label">{item.name}<span className="nodo-menu-dot" title="有正在运行的任务"><StateDot state="ongoing" size={8} /></span></span>
          : item.name,
        icon: item.worktree ? <IconBranchOutlineRegular /> : <IconWorkspaceTreeOutlineRegular /> }))]}
      onSelect={(id: string) => { setOpen(() => false); onSelect(id) }}
      anchor={button ? <Button variant="outline" size="sm" className="nodo-project-pick" {...props}>{anchor}</Button>
        : <button type="button" className="nodo-project-select" {...props}>{anchor}</button>} />
  )
}

interface RailProps {
  view: RailView; profile?: RailRole | null; workspace?: RailWorkspace | null; sessionId?: string
  editing?: { kind?: string; profile?: RailRole | null } | null; draft?: { profile?: string; workspace?: string } | null
  readOnly?: boolean; busy?: boolean; runsWaiting?: boolean; workflowNavigation?: ReactNode
  onResumeDraft: () => void; onSelect: (id: string) => void
  onSelectSession: (role: RailRole, id: string, project?: RailWorkspace) => void; onArchiveSession: (role: RailRole, id: string, archived: boolean) => void
  onRenameSession: (role: RailRole, session: RailSession) => void; onPinSession: (role: RailRole, id: string, pinned: boolean) => void
  onNewSession: (profileId?: string, project?: RailWorkspace) => void; onNewWorktree: (project: RailWorkspace) => void; onNewRole: () => void; onEditRole: (role: RailRole) => void
  onSettings: () => void; onSessions: () => void; onWorkflows: () => void; onBack: () => void
  onNewWorkspace: () => void; onRenameWorkspace: (workspace: RailWorkspace) => void; onDeleteWorkspace: (workspace: RailWorkspace) => void
}

export function Rail({ view, profile, workspace, sessionId, editing, draft, onResumeDraft, onSelect, onSelectSession, onArchiveSession, onRenameSession, onPinSession, onNewSession, onNewWorktree, onNewRole, onEditRole, onSettings, onSessions, onWorkflows, runsWaiting, onBack, onNewWorkspace, onRenameWorkspace, onDeleteWorkspace, readOnly, busy, workflowNavigation }: RailProps) {
  const [queries, setQueries] = useState<Record<string, string>>({})
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [archives, setArchives] = useState<Record<string, Archived>>({})
  const [searching, setSearching] = useState<string | null>(null)
  const [roleFilter, setRoleFilter] = useState<string | null>(null)
  const [opened, setOpened] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const busyNow = readOnly || busy
  const sessions = view.profiles.flatMap(role => role.sessions.map(session => ({ role, session,
    workspaceId: workspaceIdOf(view, role, session) })))
  const filterRole = view.profiles.find(item => item.id === roleFilter) ?? null
  type Entry = (typeof sessions)[number]
  const ordered = [...view.workspaces].reverse().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  const scopeOf = (item: RailWorkspace) => {
    const search = (queries[item.id] ?? '').trim().toLocaleLowerCase(), archived = archives[item.id] ?? 'hide'
    return { search, archived, filtering: !!search || !!filterRole || archived === 'only' }
  }
  const entriesOf = (item: RailWorkspace) => {
    const { search, archived } = scopeOf(item)
    return sessions.filter(({ role, session, workspaceId }) => workspaceId === item.id && (!filterRole || role === filterRole)
      && (archived === 'all' || (archived === 'only') === !!session.archivedAt)
      && (!search || [role.name, session.name, session.engine, item.name].some(value => String(value ?? '').toLocaleLowerCase().includes(search))))
      .sort((a, b) => (Number(!!b.session.pinnedAt) - Number(!!a.session.pinnedAt)) || (b.session.updatedAt ?? 0) - (a.session.updatedAt ?? 0))
  }
  const draftRole = draft && view.profiles.find(item => item.id === draft.profile)
  // The unsent new-conversation draft is a rail row of its own project, so the
  // draft stays reachable after switching sessions; hidden under search and
  // filters that exclude it.
  const draftIn = (item: RailWorkspace) => !!draft && draft.workspace === item.id && !scopeOf(item).search
    && scopeOf(item).archived !== 'only' && (!filterRole || filterRole.id === draft.profile)
  const action = (tip: string, label: string, icon: ReactNode, onClick: () => void, disabled?: boolean) => (
    <Tooltip label={tip} side="bottom" align="end" delayMs={500}>
      <button type="button" className="nodo-row-action" aria-label={label} disabled={disabled}
        onClick={event => { event.stopPropagation(); onClick() }}>{icon}</button>
    </Tooltip>
  )
  const liveIn = (items: RailWorkspace[]) => sessions.filter(entry => items.some(other => other.id === entry.workspaceId) && view.work[entry.session.id]?.active)
  const toggle = (key: string, open: boolean, Glyph: typeof IconBranchOutlineRegular | null, title: string, tip: string | undefined, live: Entry[]) => {
    const waiting = live.some(entry => workDot(view.work[entry.session.id]) === 'warning')
    return (
      <button type="button" className="nodo-project-select" aria-expanded={open} title={tip}
        onClick={() => setOpened(current => ({ ...current, [key]: !open }))}>
        <span className="nodo-chevron" data-open={open ? '' : undefined}><IconChevronRightOutlineRegular size={12} /></span>
        {Glyph && <span className="nodo-folder"><Glyph size={16} /></span>}
        <span className="nodo-row-title">{title}</span>
        {!open && live.length > 0 && <span className="nodo-tree-state">
          <StateDot state={waiting ? 'warning' : 'ongoing'} size={12} />{waiting ? '待处理' : `${live.length} 个运行中`}</span>}
      </button>
    )
  }
  const list = (item: RailWorkspace, entries: Entry[], pending: boolean) => {
    // Only a search must see every match; a role filter or an archived view still
    // folds to the most recent rows.
    const { search, archived } = scopeOf(item)
    const folded = !search && entries.length > SESSION_FOLD
    const visible = folded && !expanded[item.id] ? entries.slice(0, SESSION_FOLD) : entries
    return (
      <div className="nodo-tree-children">
        {pending && <button type="button" className="nodo-row nodo-session" onClick={onResumeDraft} title="新会话（草稿）">
          {draftRole ? <RoleAvatar profile={draftRole} size={18} /> : <span className="nodo-folder"><IconNewChatOutlineRegular size={16} /></span>}
          <span className="nodo-row-title">新会话</span>
        </button>}
        {visible.map(({ role, session }) => <SessionRow key={session.id} role={role} session={session} busy={busy}
          current={session.id === sessionId && !editing} work={view.work[session.id]}
          onSelect={() => onSelectSession(role, session.id, item)} onArchive={archived => onArchiveSession(role, session.id, archived)}
          onRename={() => onRenameSession(role, session)} onPin={pinned => onPinSession(role, session.id, pinned)} />)}
        {folded && <button type="button" className="nodo-show-more" aria-expanded={!!expanded[item.id]}
          onClick={() => setExpanded(current => ({ ...current, [item.id]: !current[item.id] }))}>{expanded[item.id] ? '收起' : '显示更多'}</button>}
        {!entries.length && !pending && <p className="nodo-rail-empty nodo-session-empty" role="status">
          {search || filterRole ? '没有找到匹配的会话' : archived === 'only' ? '暂无已归档会话' : '暂无会话'}</p>}
      </div>
    )
  }
  const node = (item: RailWorkspace): ReactNode => {
    const { search, archived, filtering } = scopeOf(item)
    const entries = entriesOf(item)
    const pending = draftIn(item)
    const searchOpen = searching === item.id || !!queries[item.id]
    if (filtering && !entries.length && !pending && !search && archived !== 'only' && !searchOpen) return null
    const open = opened[item.id] ?? (filtering || searchOpen || item.id === workspace?.id)
    return (
      <div key={item.id} className="nodo-tree-node">
        <div className="nodo-project" data-menu={menuOpen === item.id ? 'open' : undefined}>
          {toggle(item.id, open, item.worktree ? IconBranchOutlineRegular : IconFolderOpenOutlineRegular, item.name,
            item.worktree ? `${item.worktree.branch} · ${item.cwd}` : item.cwd, liveIn([item]))}
          {archived !== 'hide' && <span className="nodo-tree-flag" title={ARCHIVED_VIEWS[archived]}><IconArchiveOutlineRegular size={14} /></span>}
          <span className="nodo-row-actions">
            {action('新会话', `在“${item.name}”中新建会话`, <IconNewChatOutlineRegular />, () => onNewSession(filterRole?.id ?? profile?.id, item), busyNow)}
            <Menu open={menuOpen === item.id} onClose={() => setMenuOpen(null)} portal closeOnPointerLeave selectedId={`archived:${archived}`}
              items={[
                { id: 'search', label: '搜索会话', icon: <IconSearchOutlineRegular /> },
                ...Object.entries(ARCHIVED_VIEWS).map(([id, label]) => ({ id: `archived:${id}`, label,
                  icon: id === 'hide' ? <IconArchiveOffOutlineRegular /> : <IconArchiveOutlineRegular /> })),
                ...(item.worktree ? [] : [{ id: 'worktree', label: '创建工作树…', icon: <IconBranchOutlineRegular />, disabled: busyNow }]),
                { id: 'rename', label: '重命名', icon: <IconEditOutlineRegular />, disabled: busyNow },
                { id: 'delete', label: '删除工作区', icon: <IconTrashOutlineRegular />, danger: true, disabled: busyNow },
              ]}
              onSelect={(id: string) => {
                setMenuOpen(null)
                if (id === 'search') { setSearching(item.id); setOpened(current => ({ ...current, [item.id]: true })) }
                else if (id.startsWith('archived:')) setArchives(current => ({ ...current, [item.id]: id.slice('archived:'.length) as Archived }))
                else if (id === 'worktree') onNewWorktree(item)
                else if (id === 'rename') onRenameWorkspace(item)
                else if (id === 'delete') onDeleteWorkspace(item)
              }}
              anchor={<button type="button" className="nodo-row-action" aria-haspopup="menu" aria-expanded={menuOpen === item.id}
                aria-label={`工作区“${item.name}”的操作`}
                onClick={event => { event.stopPropagation(); setMenuOpen(current => current === item.id ? null : item.id) }}><IconEllipsisOutlineRegular /></button>} />
          </span>
        </div>
        {searchOpen && <div className="nodo-tree-search">
          <Input type="search" autoFocus value={queries[item.id] ?? ''}
            onChange={(event: { target: { value: string } }) => setQueries(current => ({ ...current, [item.id]: event.target.value }))}
            onKeyDown={(event: { key: string }) => { if (event.key === 'Escape') { setQueries(current => ({ ...current, [item.id]: '' })); setSearching(null) } }}
            placeholder="搜索会话" aria-label={`搜索“${item.name}”的会话`} className="nodo-search-input" icon={<IconSearchOutlineRegular size={16} />} />
        </div>}
        {open && list(item, entries, pending)}
      </div>
    )
  }
  const tree = ordered.map(node).filter(Boolean)
  const projectsOpen = opened[':projects'] ?? true
  const rosterItem = (item: RailRole) => {
    const state = roleStateOf(item, view, workspace)
    const pressed = item.id === filterRole?.id
    const label = workLabel(state)
    return (
      <div key={item.id} className="nodo-roster-cell">
        <button type="button" className="nodo-roster-item" aria-pressed={pressed} title={item.name}
          aria-label={label ? `${item.name}，${label}` : item.name}
          onClick={() => { if (pressed) setRoleFilter(null); else { onSelect(item.id); setRoleFilter(item.id) } }}>
          <span className="nodo-roster-avatar"><RoleAvatar profile={item} running={state.active} size={28} />
            {workDot(state) === 'warning' && <span className="nodo-roster-dot"><StateDot state="warning" size={8} /></span>}</span>
          <span className="nodo-roster-name">{item.name}</span>
        </button>
        <button type="button" className="nodo-roster-edit" aria-label={`配置角色 ${item.name}`} title={`配置角色 ${item.name}`}
          disabled={busyNow || state.active} aria-pressed={editing?.profile?.id === item.id ? 'true' : undefined}
          onClick={() => onEditRole(item)}><IconEditOutlineRegular size={12} /></button>
      </div>
    )
  }
  const dock = (label: string, icon: ReactNode, props: Record<string, unknown>) => (
    <Tooltip label={label} side="right" delayMs={500}>
      <button type="button" className="nodo-icon-btn nodo-visible" aria-label={label} {...props}>{icon}</button>
    </Tooltip>
  )
  return (
    <aside className="nodo-rail" aria-label={workflowNavigation ? '工作流导航' : '角色与项目会话'}>
      <div className="nodo-rail-dock">
        {dock('返回普通空间', <IconChevronLeftOutlineRegular size={16} />, { onClick: onBack,
          disabled: typeof (layoutService as { selectPanel?: unknown } | null)?.selectPanel !== 'function' })}
        <div className="nodo-rail-switch" role="group" aria-label="视图">
          <Tooltip label="会话" side="right" delayMs={500}>
            <button type="button" aria-label="会话" aria-pressed={!workflowNavigation} onClick={workflowNavigation ? onSessions : undefined}><IconFlatListOutlineRegular size={18} /></button>
          </Tooltip>
          <Tooltip label="Workflow" side="right" delayMs={500}>
            <button type="button" aria-label={runsWaiting ? 'Workflow（有待处理）' : 'Workflow'} aria-pressed={!!workflowNavigation}
              onClick={workflowNavigation ? undefined : onWorkflows}><IconWorkspaceTreeOutlineRegular size={18} />
              {runsWaiting && <span className="nodo-rail-badge"><StateDot state="warning" size={8} /></span>}</button>
          </Tooltip>
        </div>
        <span className="nodo-rail-spacer" />
        {dock('设置', <IconSettingsOutlineRegular size={16} />, { onClick: onSettings, 'aria-pressed': editing?.kind === 'settings' ? 'true' : undefined })}
      </div>
      <div className="nodo-rail-body">
        {workflowNavigation ?? <Fragment>
          <div className="nodo-roster" role="group" aria-label="按角色筛选会话">
            <button type="button" className="nodo-roster-item" aria-pressed={!filterRole} onClick={() => setRoleFilter(null)}>
              <span className="nodo-roster-avatar"><IconUsersOutlineRegular size={16} /></span>
              <span className="nodo-roster-name">全部</span>
            </button>
            {view.profiles.map(rosterItem)}
            <button type="button" className="nodo-roster-item nodo-roster-add" aria-label="添加角色" disabled={busyNow} onClick={onNewRole}>
              <span className="nodo-roster-avatar"><IconPlusOutlineRegular size={14} /></span>
              <span className="nodo-roster-name">添加</span>
            </button>
          </div>
          <nav className="nodo-tree" aria-label="项目">
            <div className="nodo-tree-node">
              <div className="nodo-project">
                {toggle(':projects', projectsOpen, null, '项目', undefined, liveIn(view.workspaces))}
                <span className="nodo-tree-add">{action('添加项目', '添加项目', <IconProjectAddOutlineRegular />, onNewWorkspace, busyNow)}</span>
              </div>
              {projectsOpen && <div className="nodo-tree-children">
                {tree}
                {!tree.length && <p className="nodo-rail-empty" role="status">{view.workspaces.length ? '没有找到匹配的会话' : '添加项目 workspace'}</p>}
              </div>}
            </div>
          </nav>
        </Fragment>}
        {readOnly && <p className="nodo-rail-foot"><Tag tone="neutral">只读模式</Tag></p>}
      </div>
    </aside>
  )
}
