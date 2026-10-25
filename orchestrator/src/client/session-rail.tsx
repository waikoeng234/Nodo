import type { ReactNode } from './ui-shared.js'
import {
  h, Fragment, useState, Menu, Tooltip, Button, Input, StateDot, Tag, sectionHead, workLabel, workDot,
  sessionTime, workspaceIdOf, roleStateOf, ARCHIVED_VIEWS, SESSION_FOLD, layoutService,
  IconArchiveOutlineRegular, IconArchiveOffOutlineRegular, IconBranchOutlineRegular, IconChevronDownOutlineRegular,
  IconChevronLeftOutlineRegular, IconEditOutlineRegular, IconEllipsisOutlineRegular, IconFolderOpenOutlineRegular,
  IconNewChatOutlineRegular, IconPinFillRegular, IconPinOutlineRegular, IconPlusOutlineRegular,
  IconProjectAddOutlineRegular, IconSearchOutlineRegular, IconSettingsOutlineRegular, IconSlidersTwoOutlineRegular,
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
  onResumeDraft: () => void; onSelect: (id: string) => void; onSelectWorkspace: (id: string) => void
  onSelectSession: (role: RailRole, id: string) => void; onArchiveSession: (role: RailRole, id: string, archived: boolean) => void
  onRenameSession: (role: RailRole, session: RailSession) => void; onPinSession: (role: RailRole, id: string, pinned: boolean) => void
  onNewSession: (profileId?: string) => void; onNewWorktree: () => void; onNewRole: () => void; onEditRole: (role: RailRole) => void
  onSettings: () => void; onSessions: () => void; onWorkflows: () => void; onBack: () => void
  onNewWorkspace: () => void; onRenameWorkspace: (workspace: RailWorkspace) => void; onDeleteWorkspace: (workspace: RailWorkspace) => void
}

export function Rail({ view, profile, workspace, sessionId, editing, draft, onResumeDraft, onSelect, onSelectWorkspace, onSelectSession, onArchiveSession, onRenameSession, onPinSession, onNewSession, onNewWorktree, onNewRole, onEditRole, onSettings, onSessions, onWorkflows, runsWaiting, onBack, onNewWorkspace, onRenameWorkspace, onDeleteWorkspace, readOnly, busy, workflowNavigation }: RailProps) {
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [archivedView, setArchivedView] = useState<Archived>('hide')
  const [filterOpen, setFilterOpen] = useState(false)
  const [roleFilter, setRoleFilter] = useState<string | null>(null)
  const [roleOpen, setRoleOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const busyNow = readOnly || busy
  const search = query.trim().toLocaleLowerCase()
  const sessions = view.profiles.flatMap(role => role.sessions.map(session => ({ role, session,
    workspaceId: workspaceIdOf(view, role, session) })))
  // Workspaces with a running session, so a busy project or branch stays
  // findable while the rail lists another workspace below.
  const runningWorkspaces = new Set<string>()
  for (const { session, workspaceId } of sessions)
    if (workspaceId && view.work[session.id]?.active) runningWorkspaces.add(workspaceId)
  const filterRole = view.profiles.find(item => item.id === roleFilter) ?? null
  type Entry = (typeof sessions)[number]
  const matches = ({ role, session }: Entry, workspace: RailWorkspace) => !search || [role.name, session.name, session.engine, workspace.name].some(value => String(value ?? '').toLocaleLowerCase().includes(search))
  const shown = ({ session }: Entry) => archivedView === 'all' || (archivedView === 'only') === !!session.archivedAt
  const entries = workspace ? sessions.filter(item => item.workspaceId === workspace.id && (!filterRole || item.role === filterRole) && shown(item) && matches(item, workspace))
    .sort((a, b) => (Number(!!b.session.pinnedAt) - Number(!!a.session.pinnedAt)) || (b.session.updatedAt ?? 0) - (a.session.updatedAt ?? 0)) : []
  // The unsent new-conversation draft is a rail row of its own project, so the
  // draft stays reachable after switching sessions; hidden under search and
  // filters that exclude it.
  const draftRole = draft && view.profiles.find(item => item.id === draft.profile)
  const draftRow = draft && workspace && draft.workspace === workspace.id && !search && archivedView !== 'only'
    && (!filterRole || filterRole.id === draft.profile)
    ? <button type="button" className="nodo-row nodo-session" onClick={onResumeDraft} title="新会话（草稿）">
      {draftRole ? <RoleAvatar profile={draftRole} size={18} /> : <span className="nodo-folder"><IconNewChatOutlineRegular size={16} /></span>}
      <span className="nodo-row-title">新会话</span>
    </button>
    : null
  // Only a search must see every match; a role filter or an archived view still
  // folds to the most recent rows.
  const folded = !search && entries.length > SESSION_FOLD
  const visible = folded && !expanded ? entries.slice(0, SESSION_FOLD) : entries
  const roleRow = (item: RailRole) => {
    const state = roleStateOf(item, view, workspace)
    const selected = item.id === profile?.id && !editing ? 'true' : undefined
    const description = item.role || item.instructions || item.engine
    return (
      <div key={item.id} className="nodo-role" data-selected={selected}>
        <button type="button" className="nodo-role-select" onClick={() => { onSelect(item.id); setRoleFilter(item.id) }} aria-current={selected}>
          <RoleAvatar profile={item} running={state.active} />
          <span className="nodo-role-text">
            <span className="nodo-row-title">{item.name}</span>
            <span className="nodo-role-description" title={description}>{description}</span>
          </span>
        </button>
        {workLabel(state) && <span className="nodo-row-state" title={`${workLabel(state)}，排队 ${state.queued}`}>
          <StateDot state={workDot(state)} size={12} />{workLabel(state)}</span>}
        <Tooltip label={`配置角色 ${item.name}`} side="bottom" align="end" delayMs={500}>
          <button type="button" className="nodo-icon-btn nodo-role-config" disabled={busyNow || state.active}
            aria-label={`配置角色 ${item.name}`} onClick={() => onEditRole(item)}
            aria-pressed={editing?.profile?.id === item.id ? 'true' : undefined}><IconSlidersTwoOutlineRegular size={16} /></button>
        </Tooltip>
      </div>
    )
  }
  const action = (tip: string, label: string, icon: ReactNode, onClick: () => void, disabled?: boolean) => (
    <Tooltip label={tip} side="bottom" align="end" delayMs={500}>
      <button type="button" className="nodo-row-action" aria-label={label} disabled={disabled}
        onClick={event => { event.stopPropagation(); onClick() }}>{icon}</button>
    </Tooltip>
  )
  return (
    <aside className="nodo-rail" aria-label={workflowNavigation ? '工作流导航' : '角色与项目会话'}>
      <div className="nodo-rail-head">
        <Tooltip label="返回普通空间" side="bottom" delayMs={500}>
          <button type="button" className="nodo-icon-btn nodo-visible" aria-label="返回普通空间"
            disabled={typeof (layoutService as { selectPanel?: unknown } | null)?.selectPanel !== 'function'} onClick={onBack}><IconChevronLeftOutlineRegular size={16} /></button>
        </Tooltip>
        <div className="nodo-rail-switch" role="group" aria-label="视图">
          <button type="button" aria-pressed={!workflowNavigation} onClick={workflowNavigation ? onSessions : undefined}>会话</button>
          <button type="button" aria-pressed={!!workflowNavigation} onClick={workflowNavigation ? undefined : onWorkflows}
            aria-label={runsWaiting ? 'Workflow（有待处理）' : undefined}>Workflow{runsWaiting && <StateDot state="warning" size={8} />}</button>
        </div>
        <Tooltip label="设置" side="bottom" align="end" delayMs={500}>
          <button type="button" className="nodo-icon-btn nodo-visible" aria-label="设置" onClick={onSettings}
            aria-pressed={editing?.kind === 'settings' ? 'true' : undefined}><IconSettingsOutlineRegular size={16} /></button>
        </Tooltip>
      </div>
      {workflowNavigation ?? <div className="nodo-rail-list">
        <section aria-label="角色" className="nodo-roles">
          {sectionHead('角色', <Tooltip label="添加角色" side="bottom" align="end" delayMs={500}>
            <button type="button" className="nodo-icon-btn nodo-visible" aria-label="添加角色" disabled={busyNow} onClick={onNewRole}><IconPlusOutlineRegular size={16} /></button>
          </Tooltip>)}
          <div className="nodo-role-list">
            {view.profiles.map(roleRow)}
            {!view.profiles.length && <p className="nodo-rail-empty">添加角色，开始协作</p>}
          </div>
        </section>
        <section aria-label="项目" className="nodo-projects">
          {sectionHead('项目', <Fragment>
            <Menu open={filterOpen} onClose={() => setFilterOpen(false)} portal selectedId={archivedView} align="end"
              items={Object.entries(ARCHIVED_VIEWS).map(([id, label]) => ({ id, label, icon: id === 'hide' ? <IconArchiveOffOutlineRegular /> : <IconArchiveOutlineRegular /> }))}
              onSelect={(id: Archived) => { setFilterOpen(false); setArchivedView(id) }}
              anchor={<button type="button" className="nodo-icon-btn nodo-visible" aria-haspopup="menu" aria-expanded={filterOpen}
                aria-label="会话筛选" title={ARCHIVED_VIEWS[archivedView]} data-active={archivedView !== 'hide' ? '' : undefined}
                onClick={() => setFilterOpen(open => !open)}><IconArchiveOutlineRegular size={16} /></button>} />
            <Tooltip label="添加项目" side="bottom" align="end" delayMs={500}>
              <button type="button" className="nodo-icon-btn nodo-visible" disabled={busyNow}
                aria-label="添加项目" onClick={onNewWorkspace}><IconProjectAddOutlineRegular size={16} /></button>
            </Tooltip>
          </Fragment>)}
          {workspace && <div key={workspace.id} className="nodo-project-body">
            <div className="nodo-project nodo-project-field" data-menu={menuOpen ? 'open' : undefined}>{searching || query
              ? <div className="nodo-search"><Input type="search" value={query} autoFocus
                onChange={(event: { target: { value: string } }) => setQuery(event.target.value)}
                onKeyDown={(event: { key: string }) => { if (event.key === 'Escape') { setQuery(''); setSearching(false) } }}
                onBlur={() => { if (!query.trim()) { setQuery(''); setSearching(false) } }}
                placeholder="搜索当前项目会话…" aria-label="搜索当前项目会话" className="nodo-search-input"
                icon={<IconSearchOutlineRegular size={16} />} /></div>
              : <Fragment>
                {workspacePicker({ workspaces: view.workspaces, workspace, running: runningWorkspaces, open: pickerOpen, setOpen: setPickerOpen, onSelect: onSelectWorkspace })}
                <span className="nodo-row-actions">
                  {action('搜索会话', '搜索当前项目会话', <IconSearchOutlineRegular />, () => setSearching(true))}
                  {action('新建工作树', `从“${workspace.name}”创建工作树`, <IconBranchOutlineRegular />, onNewWorktree, busyNow)}
                  {/* No keycap: the host owns ⌘N at the app layer (it opens a native
                      session), so the panel's new-session is the button only. */}
                  {action('新会话', `在“${workspace.name}”中新建会话`, <IconNewChatOutlineRegular />, () => onNewSession(filterRole?.id ?? profile?.id), busyNow)}
                  <Menu open={menuOpen} onClose={() => setMenuOpen(false)} portal closeOnPointerLeave
                    items={[
                      { id: 'worktree', label: '创建工作树…', icon: <IconBranchOutlineRegular />, disabled: busyNow },
                      { id: 'rename', label: '重命名', icon: <IconEditOutlineRegular /> },
                      { id: 'delete', label: '删除工作区', icon: <IconTrashOutlineRegular />, danger: true },
                    ]}
                    onSelect={(id: string) => {
                      setMenuOpen(false)
                      if (id === 'worktree') onNewWorktree()
                      else if (id === 'rename') onRenameWorkspace(workspace)
                      else if (id === 'delete') onDeleteWorkspace(workspace)
                    }}
                    anchor={<button type="button" className="nodo-row-action" aria-haspopup="menu" aria-expanded={menuOpen}
                      aria-label={`工作区“${workspace.name}”的操作`} disabled={busyNow}
                      onClick={event => { event.stopPropagation(); setMenuOpen(open => !open) }}><IconEllipsisOutlineRegular /></button>} />
                </span>
              </Fragment>}
            </div>
            <div className="nodo-project nodo-role-filter" data-menu={roleOpen ? 'open' : undefined}>
              <Menu open={roleOpen} onClose={() => setRoleOpen(false)} portal selectedId={roleFilter ?? 'all'} align="start" className="nodo-picker"
                items={[{ id: 'all', label: '全部角色', icon: <IconUsersOutlineRegular /> },
                  ...view.profiles.map(item => ({ id: item.id, label: item.name, icon: <RoleAvatar profile={item} size={16} /> }))]}
                onSelect={(id: string) => { setRoleOpen(false); setRoleFilter(id === 'all' ? null : id) }}
                anchor={<button type="button" className="nodo-project-select" aria-haspopup="menu"
                  aria-expanded={roleOpen} aria-label={`按角色筛选会话，当前 ${filterRole?.name ?? '全部角色'}`}
                  onClick={event => { event.stopPropagation(); setRoleOpen(open => !open) }}>
                  <span className="nodo-folder">{filterRole ? <RoleAvatar profile={filterRole} size={16} /> : <IconUsersOutlineRegular size={16} />}</span>
                  <span className="nodo-row-title">{filterRole?.name ?? '全部角色'}</span>
                  <span className="nodo-chevron" data-open={roleOpen ? '' : undefined}><IconChevronDownOutlineRegular size={14} /></span>
                </button>} />
            </div>
            <div className="nodo-sessions">
              {draftRow}
              {visible.map(({ role, session }) => <SessionRow key={session.id} role={role} session={session} busy={busy}
                current={session.id === sessionId && !editing} work={view.work[session.id]}
                onSelect={() => onSelectSession(role, session.id)} onArchive={archived => onArchiveSession(role, session.id, archived)}
                onRename={() => onRenameSession(role, session)} onPin={pinned => onPinSession(role, session.id, pinned)} />)}
              {folded && <button type="button" className="nodo-show-more" aria-expanded={expanded}
                onClick={() => setExpanded(open => !open)}>{expanded ? '收起' : '显示更多'}</button>}
              {!entries.length && !draftRow && <p className="nodo-rail-empty nodo-session-empty" role="status">
                {search || filterRole ? '没有找到匹配的会话' : archivedView === 'only' ? '暂无已归档会话' : '暂无会话'}</p>}
            </div>
          </div>}
          {!workspace && <p className="nodo-rail-empty" role="status">添加项目 workspace</p>}
        </section>
      </div>}
      {readOnly && <p className="nodo-rail-foot"><Tag tone="neutral">只读模式</Tag></p>}
    </aside>
  )
}
