import type { ReactNode } from './ui-shared.js'
import {
  h, Fragment, useState, Menu, Tooltip, Button, WorkDot, workLabel, workKind, runningOf,
  sessionTime, workspaceIdOf, roleStateOf, ARCHIVED_VIEWS, SESSION_FOLD, layoutService,
  IconArchiveOutlineRegular, IconArchiveOffOutlineRegular, IconUnarchiveOutlineRegular, IconBranchOutlineRegular, IconChevronDownOutlineRegular,
  IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconEditOutlineRegular, IconEllipsisOutlineRegular,
  IconFlatListOutlineRegular, IconFolderOpenOutlineRegular,
  IconNewChatOutlineRegular, IconPinFillRegular, IconPinOutlineRegular, IconPlusOutlineRegular,
  IconProjectAddOutlineRegular, IconSearchOutlineRegular, IconSettingsOutlineRegular,
  IconTrashOutlineRegular, IconUsersOutlineRegular,
} from './ui-shared.js'
import { RoleAvatar } from './avatar.tsx'
import { SearchDialog } from './search-dialog.tsx'
import { roundIndex } from './round.js'

export interface RailSession { id: string; name: string; createdAt?: number; source?: { kind?: string; leadSessionId?: string }; leadMode?: boolean; archivedAt?: number; draftedAt?: number; briefSent?: boolean; pinnedAt?: number; updatedAt?: number; engine?: string; workspaceRef?: string; workspaceName?: string; profileName?: string; cwd?: string }
export interface RailRole { id: string; name: string; deletedAt?: number; role?: string; instructions?: string; engine?: string; avatarTemplate?: string; workspaceId?: string; lead?: boolean; sessions: RailSession[] }
export interface RailWorkspace { id: string; name: string; cwd: string; createdAt?: number; worktree?: { branch: string } }
export interface RailView { teams?: { id: string; name: string; lead: string | null }[]; profiles: RailRole[]; workspaces: RailWorkspace[]; work: Record<string, { active?: boolean } | undefined> }
export type RailNavigation = { view: 'roles'; content: ReactNode } | { view: 'team'; content?: never }
type Archived = keyof typeof ARCHIVED_VIEWS
const ROLE_FOLD = 5
const ROSTER_HEIGHT_KEY = 'nodo.rosterHeight'
const TREE_MIN = 120

interface SessionRowProps {
  role: RailRole; session: RailSession; current: boolean; work?: { active?: boolean }; busy?: boolean; readOnly?: boolean; context?: string
  onSelect: () => void; onArchive: (archived: boolean) => void; onRename: () => void; onPin: (pinned: boolean) => void
}

// One session row: the host row's title and meta, an archive button and a menu
// for rename and pin. Archive is refused while the session runs.
export function SessionRow({ role, session, current, work, busy, readOnly, context, onSelect, onArchive, onRename, onPin }: SessionRowProps) {
  const [open, setOpen] = useState(false)
  const archived = !!session.archivedAt
  const pinned = !!session.pinnedAt
  const running = work?.active === true
  const status = workLabel(work)
  return (
    <div className="nodo-session-item" data-menu={open ? 'open' : undefined}>
      <button type="button" className="nodo-row nodo-session" disabled={busy} data-archived={archived ? '' : undefined}
        aria-current={current ? 'page' : undefined} aria-description={archived ? '已归档会话，只读查看' : undefined}
        onClick={onSelect} title={`${role.name} · ${session.name}`}>
        <RoleAvatar profile={role} size={20} />
        <span className="nodo-row-title">{context ? `${context} · ${session.name}` : session.name}</span>
        <span className="nodo-row-meta">{archived
          ? <span className="nodo-row-archived">已归档</span>
          : status
            ? <span className="nodo-row-running" title={status}><WorkDot kind={workKind(work)} />{status}</span>
            : <Fragment>{pinned && <IconPinFillRegular size={12} />}{sessionTime(session.updatedAt)}</Fragment>}</span>
      </button>
      {!readOnly && <span className="nodo-row-actions">
        <button type="button" className="nodo-row-action" disabled={busy || running}
          aria-label={archived ? `取消归档会话“${session.name}”` : `归档会话“${session.name}”`} title={archived ? '取消归档' : '归档会话'}
          onClick={event => { event.stopPropagation(); onArchive(!archived) }}>
          {archived ? <IconUnarchiveOutlineRegular /> : <IconArchiveOutlineRegular />}
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
      </span>}
    </div>
  )
}

interface PickerOptions {
  workspaces: RailWorkspace[]; workspace?: RailWorkspace | null; running?: Set<string>; open: boolean
  setOpen: (update: (open: boolean) => boolean) => void; onSelect: (id: string) => void
  none?: string; button?: boolean; label?: string; disabled?: boolean
}

// The project picker of the rail. `none` adds a
// first item for no workspace; `button` draws the anchor as a small outline button.
export const workspacePicker = ({ workspaces, workspace, running = new Set(), open, setOpen, onSelect, none, button = false, label = '选择项目', disabled }: PickerOptions) => {
  const ordered = [...workspaces].reverse().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  const othersRunning = ordered.some(item => item.id !== workspace?.id && running.has(item.id))
  const name = workspace?.name ?? none
  const Glyph = workspace ? workspace.worktree ? IconBranchOutlineRegular : IconFolderOpenOutlineRegular : null
  const anchor = <Fragment>
    {Glyph && <span className="nodo-folder"><Glyph size={16} /></span>}
    <span className="nodo-row-title">{name}</span>
    {othersRunning && <span className="nodo-project-state" title="其他项目或分支有正在运行的任务"><WorkDot kind="run" /></span>}
    <span className="nodo-chevron" data-open={open ? '' : undefined}><IconChevronDownOutlineRegular size={14} /></span>
  </Fragment>
  const props = { disabled, 'aria-haspopup': 'menu' as const, 'aria-expanded': open, 'aria-label': `${label}，当前 ${name}`,
    title: workspace ? workspace.worktree ? `${workspace.worktree.branch} · ${workspace.cwd}` : workspace.cwd : undefined,
    onClick: (event: { stopPropagation(): void }) => { event.stopPropagation(); setOpen(value => !value) } }
  return (
    <Menu open={open} onClose={() => setOpen(() => false)} portal selectedId={workspace?.id ?? ''} align="start" className="nodo-picker"
      items={[...(none ? [{ id: '', label: none }] : []), ...ordered.map(item => ({ id: item.id,
        label: running.has(item.id)
          ? <span className="nodo-menu-label">{item.name}<span className="nodo-menu-dot" title="有正在运行的任务"><WorkDot kind="run" /></span></span>
          : item.name,
        icon: item.worktree ? <IconBranchOutlineRegular /> : <IconFolderOpenOutlineRegular /> }))]}
      onSelect={(id: string) => { setOpen(() => false); onSelect(id) }}
      anchor={button ? <Button variant="outline" size="sm" className="nodo-project-pick" {...props}>{anchor}</Button>
        : <button type="button" className="nodo-project-select" {...props}>{anchor}</button>} />
  )
}

interface RailProps {
  view: RailView; profile?: RailRole | null; workspace?: RailWorkspace | null; sessionId?: string
  editing?: { kind?: string; profile?: RailRole | null } | null; draft?: { profile?: string; workspace?: string } | null; drafting?: boolean
  readOnly?: boolean; busy?: boolean; navigation?: RailNavigation | null
  onResumeDraft: () => void; onSelect: (id: string) => void
  onSelectSession: (role: RailRole, id: string, project?: RailWorkspace) => void; onArchiveSession: (role: RailRole, id: string, archived: boolean) => void
  onRenameSession: (role: RailRole, session: RailSession) => void; onPinSession: (role: RailRole, id: string, pinned: boolean) => void
  onNewSession: (profileId?: string, project?: RailWorkspace) => void; onNewWorktree: (project: RailWorkspace) => void; onNewRole: () => void; onEditRole: (role: RailRole) => void
  onNewTeam: () => void; onEditTeam: (id: string) => void
  onSettings: () => void; onSessions: () => void; onTeam: () => void; onRoles: () => void; onBack: () => void
  onNewWorkspace: () => void; onRenameWorkspace: (workspace: RailWorkspace) => void; onDeleteWorkspace: (workspace: RailWorkspace) => void
}

export function Rail({ view, profile, workspace, sessionId, editing, draft, drafting, onResumeDraft, onSelect, onSelectSession, onArchiveSession, onRenameSession, onPinSession, onNewSession, onNewWorktree, onNewRole, onEditRole, onNewTeam, onEditTeam, onSettings, onSessions, onTeam, onRoles, onBack, onNewWorkspace, onRenameWorkspace, onDeleteWorkspace, readOnly, busy, navigation }: RailProps) {
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [archives, setArchives] = useState<Record<string, Archived>>({})
  const [searching, setSearching] = useState(false)
  const [roleFilter, setRoleFilter] = useState<string | null>(null)
  const [opened, setOpened] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [rolesOpen, setRolesOpen] = useState(false)
  const [rosterHeight, setRosterHeight] = useState<number | null>(() => { try { return Number(localStorage.getItem(ROSTER_HEIGHT_KEY)) || null } catch { return null } })
  const busyNow = readOnly || busy
  const team = navigation?.view === 'team'
  const rounds = roundIndex(view)
  const sessions = view.profiles.flatMap(role => role.sessions.map(session => ({ role, session,
    workspaceId: workspaceIdOf(view, role, session) })))
  const visibleSession = (role: RailRole, session: RailSession) => !team || (role.lead === true && (session.engine ?? role.engine) !== 'dsh' && session.leadMode !== false)
  const groupOf = (role: RailRole, session: RailSession): { role: RailRole; session: RailSession }[] => [{ role, session }, ...(team ? rounds.members.get(session.id) ?? [] : [])]
  const rowOf = (role: RailRole, session: RailSession) => {
    const group = groupOf(role, session)
    return group.length === 1 ? { session, work: view.work[session.id], current: session.id === sessionId } : {
      session: { ...session, updatedAt: Math.max(...group.map(entry => entry.session.updatedAt ?? 0)) },
      work: runningOf({ sessions: group.map(entry => entry.session) }, view.work),
      current: group.some(entry => entry.session.id === sessionId) }
  }
  const roles = view.profiles.filter(role => !role.deletedAt && (!team || (role.lead === true && role.engine !== 'dsh')))
  // Roles with a live or unread state come first, the most recently changed on top; the stable sort keeps leads before executors and stored order otherwise.
  const stateAt = (role: RailRole) => { const state = roleStateOf(role, view, workspace); return state.active || state.status ? Math.max(state.since ?? 1, state.finishedAt ?? 0, state.lastAt ?? 0) : 0 }
  const roster = [...roles].sort((a, b) => Number(b.lead === true) - Number(a.lead === true)).map(role => ({ role, at: stateAt(role) }))
    .sort((a, b) => b.at - a.at).map(entry => entry.role)
  const archivedSessions = sessions.filter(({ role, session, workspaceId }) => session.archivedAt && visibleSession(role, session)
    && (!session.draftedAt || session.briefSent)
    && (role.deletedAt || !view.workspaces.some(item => item.id === workspaceId)))
    .sort((a, b) => (b.session.updatedAt ?? 0) - (a.session.updatedAt ?? 0))
  const filterRole = roles.find(item => item.id === roleFilter) ?? null
  const draftRole = filterRole?.id ?? (team ? roles.find(role => role.id === profile?.id)?.id ?? roles[0]?.id : profile?.id)
  const draftProfile = roles.find(role => role.id === draft?.profile)
  type Entry = (typeof sessions)[number]
  const ordered = [...view.workspaces].reverse().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  const scopeOf = (item: RailWorkspace) => {
    const archived = archives[item.id] ?? 'hide'
    return { archived, filtering: !!filterRole || archived === 'only' }
  }
  const entriesOf = (item: RailWorkspace) => {
    const { archived } = scopeOf(item)
    return sessions.filter(({ role, session, workspaceId }) => !role.deletedAt && workspaceId === item.id && visibleSession(role, session)
      && (!filterRole || groupOf(role, session).some(entry => entry.role === filterRole))
      && (archived === 'all' || (archived === 'only') === !!session.archivedAt))
      .sort((a, b) => (Number(!!b.session.pinnedAt) - Number(!!a.session.pinnedAt))
        || (rowOf(b.role, b.session).session.updatedAt ?? 0) - (rowOf(a.role, a.session).session.updatedAt ?? 0))
  }
  // The unsent new-conversation draft is a rail row of its own project, so the
  // draft stays reachable after switching sessions; hidden under filters that
  // exclude it.
  const draftIn = (item: RailWorkspace) => !!draft && (!team || roles.some(role => role.id === draft.profile)) && draft.workspace === item.id
    && scopeOf(item).archived !== 'only' && (!filterRole || filterRole.id === draft.profile)
  const action = (tip: string, label: string, icon: ReactNode, onClick: () => void, disabled?: boolean) => (
    <Tooltip label={tip} side="bottom" align="end" delayMs={500}>
      <button type="button" className="nodo-row-action" aria-label={label} disabled={disabled}
        onClick={event => { event.stopPropagation(); onClick() }}>{icon}</button>
    </Tooltip>
  )
  const liveIn = (items: RailWorkspace[]) => sessions.filter(entry => items.some(other => other.id === entry.workspaceId)
    && (!team || visibleSession(entry.role, entry.session) || rounds.lead.get(entry.session.id)?.role.lead === true) && view.work[entry.session.id]?.active)
  const toggle = (key: string, open: boolean, Glyph: typeof IconBranchOutlineRegular | null, title: string, tip: string | undefined, live: Entry[]) => {
    const waiting = live.some(entry => workKind(view.work[entry.session.id]) === 'wait')
    return (
      <button type="button" className="nodo-project-select" aria-expanded={open} title={tip}
        onClick={() => setOpened(current => ({ ...current, [key]: !open }))}>
        {Glyph && <span className="nodo-folder"><Glyph size={20} /></span>}
        <span className="nodo-row-title">{title}</span>
        {!open && live.length > 0 && <span className="nodo-tree-state">
          <WorkDot kind={waiting ? 'wait' : 'run'} />{waiting ? '待处理' : `${live.length} 个运行中`}</span>}
      </button>
    )
  }
  const list = (item: RailWorkspace, entries: Entry[], pending: boolean) => {
    const { archived } = scopeOf(item)
    const folded = entries.length > SESSION_FOLD
    const visible = folded && !expanded[item.id] ? entries.slice(0, SESSION_FOLD) : entries
    return (
      <div className="nodo-tree-children">
        {pending && <button type="button" className="nodo-row nodo-session" aria-current={drafting ? 'page' : undefined} onClick={onResumeDraft} title="新会话（草稿）">
          {draftProfile ? <RoleAvatar profile={draftProfile} size={20} /> : <span className="nodo-folder"><IconNewChatOutlineRegular size={20} /></span>}
          <span className="nodo-row-title">新会话</span>
        </button>}
        {visible.map(({ role, session }) => {
          const row = rowOf(role, session)
          return <SessionRow key={session.id} role={role} session={row.session} busy={busy}
            current={row.current && !editing && !drafting} work={row.work}
            onSelect={() => onSelectSession(role, session.id, item)} onArchive={archived => onArchiveSession(role, session.id, archived)}
            onRename={() => onRenameSession(role, session)} onPin={pinned => onPinSession(role, session.id, pinned)} />
        })}
        {folded && <button type="button" className="nodo-show-more" aria-expanded={!!expanded[item.id]}
          onClick={() => setExpanded(current => ({ ...current, [item.id]: !current[item.id] }))}>{expanded[item.id] ? '收起' : '显示更多'}</button>}
        {!entries.length && !pending && <p className="nodo-rail-empty nodo-session-empty" role="status">
          {filterRole ? '没有找到匹配的会话' : archived === 'only' ? '暂无已归档会话' : '暂无会话'}</p>}
      </div>
    )
  }
  const node = (item: RailWorkspace): ReactNode => {
    const { archived, filtering } = scopeOf(item)
    const entries = entriesOf(item)
    const pending = draftIn(item)
    if (filtering && !entries.length && !pending && archived !== 'only') return null
    const open = opened[item.id] ?? (filtering || item.id === workspace?.id)
    return (
      <div key={item.id} className="nodo-tree-node">
        <div className="nodo-project" data-menu={menuOpen === item.id ? 'open' : undefined}>
          {toggle(item.id, open, item.worktree ? IconBranchOutlineRegular : IconFolderOpenOutlineRegular, item.name,
            item.worktree ? `${item.worktree.branch} · ${item.cwd}` : item.cwd, liveIn([item]))}
          {archived !== 'hide' && <span className="nodo-tree-flag" title={ARCHIVED_VIEWS[archived]}><IconArchiveOutlineRegular size={16} /></span>}
          <span className="nodo-row-actions">
            {action('新会话', `在“${item.name}”中新建会话`, <IconNewChatOutlineRegular />, () => onNewSession(draftRole, item), busyNow || (team && !roles.length))}
            <Menu open={menuOpen === item.id} onClose={() => setMenuOpen(null)} portal closeOnPointerLeave selectedId={`archived:${archived}`}
              items={[
                ...Object.entries(ARCHIVED_VIEWS).map(([id, label]) => ({ id: `archived:${id}`, label,
                  icon: id === 'hide' ? <IconArchiveOffOutlineRegular /> : <IconArchiveOutlineRegular /> })),
                ...(item.worktree ? [] : [{ id: 'worktree', label: '创建工作树…', icon: <IconBranchOutlineRegular />, disabled: busyNow }]),
                { id: 'rename', label: '重命名', icon: <IconEditOutlineRegular />, disabled: busyNow },
                { id: 'delete', label: '删除项目', icon: <IconTrashOutlineRegular />, danger: true, disabled: busyNow },
              ]}
              onSelect={(id: string) => {
                setMenuOpen(null)
                if (id.startsWith('archived:')) setArchives(current => ({ ...current, [item.id]: id.slice('archived:'.length) as Archived }))
                else if (id === 'worktree') onNewWorktree(item)
                else if (id === 'rename') onRenameWorkspace(item)
                else if (id === 'delete') onDeleteWorkspace(item)
              }}
              anchor={<button type="button" className="nodo-row-action" aria-haspopup="menu" aria-expanded={menuOpen === item.id}
                aria-label={`项目“${item.name}”的操作`}
                onClick={event => { event.stopPropagation(); setMenuOpen(current => current === item.id ? null : item.id) }}><IconEllipsisOutlineRegular /></button>} />
          </span>
        </div>
        {open && list(item, entries, pending)}
      </div>
    )
  }
  const tree = ordered.map(node).filter(Boolean)
  // Roles past the fold stay hidden until expanded, except the filtered one.
  const shownRoles = rolesOpen ? roster : roster.filter((item, index) => index < ROLE_FOLD || item === filterRole)
  const rosterItem = (item: RailRole) => {
    const state = roleStateOf(item, view, workspace)
    const pressed = item.id === filterRole?.id
    const label = workLabel(state)
    const group = team ? view.teams?.find(entry => entry.lead === item.id) : undefined
    const name = team && group ? group.name || '未命名团队' : item.name
    return (
      <div key={item.id} className="nodo-roster-cell">
        <button type="button" className="nodo-roster-item" aria-current={pressed || undefined} title={name}
          aria-label={label ? `${name}，${label}` : name}
          onClick={() => { if (pressed) setRoleFilter(null); else { onSelect(item.id); setRoleFilter(item.id) } }}>
          <span className="nodo-roster-avatar"><RoleAvatar profile={item} running={state.active} size={20} /></span>
          <span className="nodo-roster-name">{name}</span>
          {label && <span className="nodo-row-running"><WorkDot kind={workKind(state)} />{label}</span>}
        </button>
        <span className="nodo-row-actions">
          <button type="button" className="nodo-row-action" aria-label={`${group ? '配置团队' : '配置角色'} ${name}`} title={group ? '配置团队' : '配置角色'}
            disabled={busyNow || state.active} onClick={() => group ? onEditTeam(group.id) : onEditRole(item)}><IconEditOutlineRegular /></button>
        </span>
      </div>
    )
  }
  const head = (title: string, add: ReactNode) => <div className="nodo-rail-head"><span className="nodo-rail-title">{title}</span>{add}</div>
  const dock = (label: string, icon: ReactNode, props: Record<string, unknown>) => (
    <Tooltip label={label} side="right" delayMs={500}>
      <button type="button" className="nodo-icon-btn nodo-visible" aria-label={label} {...props}>{icon}</button>
    </Tooltip>
  )
  const searchItems = () => sessions.filter(({ role, session, workspaceId }) => !role.deletedAt && !session.archivedAt && visibleSession(role, session)
    && view.workspaces.some(item => item.id === workspaceId))
    .map(({ role, session, workspaceId }) => {
      const project = view.workspaces.find(item => item.id === workspaceId) as RailWorkspace, row = rowOf(role, session)
      return { id: session.id, role, name: session.name, project, updatedAt: row.session.updatedAt, work: row.work,
        terms: [...groupOf(role, session).flatMap(entry => [entry.role.name, entry.session.name]), session.engine, project.name],
        pick: () => onSelectSession(role, session.id, project) }
    })
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  const saveRosterHeight = (height: number | null) => {
    setRosterHeight(height)
    try { if (height) localStorage.setItem(ROSTER_HEIGHT_KEY, String(height)); else localStorage.removeItem(ROSTER_HEIGHT_KEY) } catch {}
  }
  const rosterLimit = (split: HTMLElement) => {
    const roster = split.previousElementSibling as HTMLElement, list = roster.firstElementChild as HTMLElement
    const rows = [...list.children].slice(0, 2).reduce((sum, row) => sum + (row as HTMLElement).offsetHeight + 2, 0)
    const rest = roster.offsetHeight - list.clientHeight, room = split.parentElement!.getBoundingClientRect().bottom - roster.getBoundingClientRect().top - split.offsetHeight - TREE_MIN
    const min = rest + rows, max = Math.max(min, Math.min(rest + list.scrollHeight, room))
    return { start: roster.offsetHeight, clamp: (height: number) => Math.round(Math.min(Math.max(height, min), max)) }
  }
  const nudgeRoster = (split: HTMLElement, delta: number) => {
    const { start, clamp } = rosterLimit(split)
    saveRosterHeight(clamp(start + delta))
  }
  const resizeRoster = (event: { currentTarget: HTMLElement; clientY: number; button: number; preventDefault: () => void }) => {
    if (event.button !== 0) return
    event.preventDefault()
    const { start, clamp } = rosterLimit(event.currentTarget), from = event.clientY
    let height = start
    const move = (next: PointerEvent) => { height = clamp(start + next.clientY - from); setRosterHeight(height) }
    const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); saveRosterHeight(height) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
  }
  return (
    <aside className="nodo-rail" aria-label={navigation?.view === 'roles' ? '角色导航' : '角色与项目会话'}>
      <div className="nodo-rail-dock">
        {dock('主页', <IconFlatListOutlineRegular size={18} />, { 'aria-pressed': !navigation?.content, onClick: navigation?.content ? onSessions : undefined })}
        {dock('新建会话', <IconNewChatOutlineRegular size={18} />, { onClick: () => onNewSession(draftRole),
          disabled: busyNow || !workspace || navigation?.view === 'roles' || (team && !roles.length) })}
        {dock('搜索', <IconSearchOutlineRegular size={18} />, { 'aria-pressed': searching,
          onClick: () => { if (navigation?.view === 'roles') onSessions(); setSearching(current => !current) } })}
        {dock('角色', <IconUsersOutlineRegular size={18} />, { 'aria-pressed': navigation?.view === 'roles',
          onClick: navigation?.view === 'roles' ? undefined : onRoles })}
        <span className="nodo-rail-spacer" />
        {dock('设置', <IconSettingsOutlineRegular size={16} />, { onClick: onSettings, 'aria-pressed': editing?.kind === 'settings' ? 'true' : undefined })}
        {dock('返回普通空间', <IconChevronLeftOutlineRegular size={16} />, { onClick: onBack,
          disabled: typeof (layoutService as { selectPanel?: unknown } | null)?.selectPanel !== 'function' })}
      </div>
      <div className="nodo-rail-body">
        {navigation?.content ?? <Fragment>
          <div className="nodo-rail-tabs" role="tablist" aria-label="主页视图">
            <button type="button" role="tab" aria-selected={!team} onClick={team ? onSessions : undefined}>角色</button>
            <button type="button" role="tab" aria-selected={team} onClick={team ? undefined : onTeam}>团队</button>
          </div>
          <div className="nodo-roster" role="group" aria-label="按角色查看会话" style={rosterHeight ? { maxHeight: rosterHeight } : undefined}>
            <div className="nodo-roster-list">{shownRoles.map(rosterItem)}</div>
            {roster.length > ROLE_FOLD && <button type="button" className="nodo-roster-more" aria-expanded={rolesOpen}
              onClick={() => { if (!rolesOpen) saveRosterHeight(null); setRolesOpen(current => !current) }}>{rolesOpen ? '收起' : '显示更多'}</button>}
            <div className="nodo-roster-cell">
              <button type="button" className="nodo-roster-item nodo-roster-new" disabled={busyNow} onClick={team ? onNewTeam : onNewRole}>
                <span className="nodo-roster-plus"><IconPlusOutlineRegular size={12} /></span><span className="nodo-roster-name">{team ? '新建团队' : '新建角色'}</span>
              </button>
            </div>
          </div>
          <div className="nodo-rail-split" role="separator" aria-orientation="horizontal" aria-label="调整角色区高度" tabIndex={0}
            onPointerDown={resizeRoster} onDoubleClick={() => saveRosterHeight(null)}
            onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); nudgeRoster(event.currentTarget, event.key === 'ArrowUp' ? -16 : 16) } }} />
          <nav className="nodo-tree" aria-label="项目">
            {head('项目区', action('添加项目', '添加项目', <IconProjectAddOutlineRegular />, onNewWorkspace, busyNow))}
            {tree}
            {!tree.length && <p className="nodo-rail-empty" role="status">{view.workspaces.length ? '没有找到匹配的会话' : '添加项目'}</p>}
            {!!archivedSessions.length && <div className="nodo-tree-node">
              <div className="nodo-project">{toggle(':archived', !!opened[':archived'], IconArchiveOutlineRegular, '已移除', undefined, [])}</div>
              {opened[':archived'] && <div className="nodo-tree-children">
                {archivedSessions.map(({ role, session, workspaceId }) => <SessionRow key={session.id} role={role} session={session} busy={busy} readOnly
                  current={rowOf(role, session).current && !editing && !drafting}
                  context={`${session.profileName ?? role.name} · ${session.workspaceName ?? view.workspaces.find(item => item.id === workspaceId)?.name ?? session.cwd ?? '未指定项目'}`}
                  onSelect={() => onSelectSession(role, session.id)} onArchive={() => {}} onRename={() => {}} onPin={() => {}} />)}
              </div>}
            </div>}
          </nav>
        </Fragment>}
        {searching && <SearchDialog items={searchItems()} onClose={() => setSearching(false)} />}
        {readOnly && <p className="nodo-rail-foot"><span className="nodo-tag">只读模式</span></p>}
      </div>
    </aside>
  )
}
