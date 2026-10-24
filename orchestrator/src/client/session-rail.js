import {
  h, Fragment, useState, Menu, Tooltip, Button, Input, StateDot, Tag, NodoLogo, sectionHead, workLabel, workDot,
  sessionTime, workspaceIdOf, roleStateOf, ARCHIVED_VIEWS, SESSION_FOLD, layoutService,
  IconArchiveOutlineRegular, IconArchiveOffOutlineRegular, IconBranchOutlineRegular, IconChevronDownOutlineRegular,
  IconChevronLeftOutlineRegular, IconEditOutlineRegular, IconEllipsisOutlineRegular, IconFolderOpenOutlineRegular,
  IconNewChatOutlineRegular, IconPinFillRegular, IconPinOutlineRegular, IconPlanOutlineRegular, IconPlusOutlineRegular,
  IconProjectAddOutlineRegular, IconSearchOutlineRegular, IconSettingsOutlineRegular, IconSlidersTwoOutlineRegular,
  IconTrashOutlineRegular, IconUsersOutlineRegular, IconWorkspaceTreeOutlineRegular,
} from './ui-shared.js'
import { RoleAvatar } from './avatar.tsx'

// One session row: the host row's title and meta, an archive button and a menu
// for rename and pin. Archive is refused while the session runs; an archived row
// cannot be opened until it is unarchived, the host sidebar's rule.
export function SessionRow({ role, session, current, work, busy, onSelect, onArchive, onRename, onPin }) {
  const [open, setOpen] = useState(false)
  const archived = !!session.archivedAt
  const pinned = !!session.pinnedAt
  const label = `${role.name} · ${session.name}`
  const running = work?.active === true
  const status = workLabel(work)
  return h('div', { className: 'nodo-session-item', 'data-menu': open ? 'open' : undefined },
    h('button', { type: 'button', className: 'nodo-row nodo-session', disabled: busy || archived, 'data-archived': archived ? '' : undefined,
      'aria-current': current ? 'page' : undefined, 'aria-description': archived ? '已归档会话暂时无法查看，请取消归档后查看' : undefined,
      onClick: onSelect, title: label },
    h(RoleAvatar, { profile: role, size: 18 }),
    h('span', { className: 'nodo-row-title' }, session.name),
    h('span', { className: 'nodo-row-meta' }, archived
      ? h('span', { className: 'nodo-row-archived' }, h(IconArchiveOutlineRegular, { size: 12 }), '已归档')
      : status
        ? h('span', { className: 'nodo-row-running', title: status }, h(StateDot, { state: workDot(work), size: 12 }), status)
        : h(Fragment, null, pinned && h(IconPinFillRegular, { size: 12 }), sessionTime(session.updatedAt)))),
    h('span', { className: 'nodo-row-actions' },
      h('button', { type: 'button', className: 'nodo-row-action', disabled: busy || running,
        'aria-label': archived ? `取消归档会话“${session.name}”` : `归档会话“${session.name}”`, title: archived ? '取消归档' : '归档会话',
        onClick: event => { event.stopPropagation(); onArchive(!archived) } },
      h(archived ? IconArchiveOffOutlineRegular : IconArchiveOutlineRegular)),
      h(Menu, {
        open, onClose: () => setOpen(false), portal: true, closeOnPointerLeave: true,
        items: [
          { id: 'rename', label: '修改会话名称', icon: h(IconEditOutlineRegular), disabled: busy },
          { id: 'pin', label: pinned ? '取消置顶' : '置顶会话', icon: pinned ? h(IconPinFillRegular) : h(IconPinOutlineRegular), disabled: busy || archived },
        ],
        onSelect: id => { setOpen(false); if (id === 'rename') onRename(); else onPin(!pinned) },
        anchor: h('button', { type: 'button', className: 'nodo-row-action', 'aria-haspopup': 'menu', 'aria-expanded': open,
          'aria-label': `会话“${session.name}”的更多操作`, disabled: busy,
          onClick: event => { event.stopPropagation(); setOpen(current => !current) } }, h(IconEllipsisOutlineRegular)),
      })))
}

// The project picker of the rail, also used by the workflow canvas. `none` adds a
// first item for no workspace; `button` draws the anchor as a small outline button.
export const workspacePicker = ({ workspaces, workspace, running = new Set(), open, setOpen, onSelect, none, button = false, label = '选择项目', disabled }) => {
  const ordered = [...workspaces].reverse().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  const othersRunning = ordered.some(item => item.id !== workspace?.id && running.has(item.id))
  const name = workspace?.name ?? none
  const anchor = [
    h('span', { className: 'nodo-folder' }, h(workspace ? workspace.worktree ? IconBranchOutlineRegular : IconFolderOpenOutlineRegular : IconUsersOutlineRegular, { size: 16 })),
    h('span', { className: 'nodo-row-title' }, name),
    othersRunning && h('span', { className: 'nodo-project-state', title: '其他项目或分支有正在运行的任务' },
      h(StateDot, { state: 'ongoing', size: 12 })),
    h('span', { className: 'nodo-chevron', 'data-open': open ? '' : undefined }, h(IconChevronDownOutlineRegular, { size: 14 }))]
  const props = { disabled, 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-label': `${label}，当前 ${name}`,
    title: workspace && (workspace.worktree ? `${workspace.worktree.branch} · ${workspace.cwd}` : workspace.cwd),
    onClick: event => { event.stopPropagation(); setOpen(value => !value) } }
  return h(Menu, {
    open, onClose: () => setOpen(false), portal: true, selectedId: workspace?.id ?? '', align: 'start', className: 'nodo-picker',
    items: [...(none ? [{ id: '', label: none, icon: h(IconUsersOutlineRegular) }] : []), ...ordered.map(item => ({ id: item.id,
      label: running.has(item.id)
        ? h('span', { className: 'nodo-menu-label' }, item.name,
          h('span', { className: 'nodo-menu-dot', title: '有正在运行的任务' }, h(StateDot, { state: 'ongoing', size: 8 })))
        : item.name,
      icon: h(item.worktree ? IconBranchOutlineRegular : IconWorkspaceTreeOutlineRegular) }))],
    onSelect: id => { setOpen(false); onSelect(id) },
    anchor: button ? h(Button, { variant: 'outline', size: 'sm', className: 'nodo-project-pick', ...props }, ...anchor)
      : h('button', { type: 'button', className: 'nodo-project-select', ...props }, ...anchor),
  })
}

export function Rail({ view, profile, workspace, sessionId, editing, draft, onResumeDraft, onSelect, onSelectWorkspace, onSelectSession, onArchiveSession, onRenameSession, onPinSession, onNewSession, onNewWorktree, onNewRole, onEditRole, onSettings, onWorkflows, runsWaiting, onBack, onNewWorkspace, onRenameWorkspace, onDeleteWorkspace, readOnly, busy, workflowNavigation }) {
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [archivedView, setArchivedView] = useState('hide')
  const [filterOpen, setFilterOpen] = useState(false)
  const [roleFilter, setRoleFilter] = useState(null)
  const [roleOpen, setRoleOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const busyNow = readOnly || busy
  const search = query.trim().toLocaleLowerCase()
  const sessions = view.profiles.flatMap(role => role.sessions.map(session => ({ role, session,
    workspaceId: workspaceIdOf(view, role, session) })))
  // Workspaces with a running session, so a busy project or branch stays
  // findable while the rail lists another workspace below.
  const runningWorkspaces = new Set()
  for (const { role, session, workspaceId } of sessions)
    if (workspaceId && view.work[session.id]?.active) runningWorkspaces.add(workspaceId)
  const filterRole = view.profiles.find(item => item.id === roleFilter) ?? null
  const matches = ({ role, session }, workspace) => !search || [role.name, session.name, session.engine, workspace.name].some(value => String(value ?? '').toLocaleLowerCase().includes(search))
  const shown = ({ session }) => archivedView === 'all' || (archivedView === 'only') === !!session.archivedAt
  const entries = workspace ? sessions.filter(item => item.workspaceId === workspace.id && (!filterRole || item.role === filterRole) && shown(item) && matches(item, workspace))
    .sort((a, b) => (!!b.session.pinnedAt - !!a.session.pinnedAt) || (b.session.updatedAt ?? 0) - (a.session.updatedAt ?? 0)) : []
  // The unsent new-conversation draft is a rail row of its own project, so the
  // draft stays reachable after switching sessions; hidden under search and
  // filters that exclude it.
  const draftRole = draft && view.profiles.find(item => item.id === draft.profile)
  const draftRow = draft && workspace && draft.workspace === workspace.id && !search && archivedView !== 'only'
    && (!filterRole || filterRole.id === draft.profile)
    ? h('button', { type: 'button', className: 'nodo-row nodo-session', onClick: onResumeDraft, title: '新会话（草稿）' },
      draftRole ? h(RoleAvatar, { profile: draftRole, size: 18 }) : h('span', { className: 'nodo-folder' }, h(IconNewChatOutlineRegular, { size: 16 })),
      h('span', { className: 'nodo-row-title' }, '新会话'))
    : null
  // Only a search must see every match; a role filter or an archived view still
  // folds to the most recent rows.
  const folded = !search && entries.length > SESSION_FOLD
  const visible = folded && !expanded ? entries.slice(0, SESSION_FOLD) : entries
  const roleRow = (item) => {
    const state = roleStateOf(item, view, workspace)
    return h('div', { key: item.id, className: 'nodo-role', 'data-selected': item.id === profile?.id && !editing ? 'true' : undefined },
      h('button', { type: 'button', className: 'nodo-role-select', onClick: () => { onSelect(item.id); setRoleFilter(item.id) },
        'aria-current': item.id === profile?.id && !editing ? 'true' : undefined },
      h(RoleAvatar, { profile: item, running: state.active }),
      h('span', { className: 'nodo-role-text' },
        h('span', { className: 'nodo-row-title' }, item.name),
        h('span', { className: 'nodo-role-description', title: item.role || item.instructions || item.engine }, item.role || item.instructions || item.engine))),
      workLabel(state) && h('span', { className: 'nodo-row-state', title: `${workLabel(state)}，排队 ${state.queued}` },
        h(StateDot, { state: workDot(state), size: 12 }), workLabel(state)),
      h(Tooltip, { label: `配置角色 ${item.name}`, side: 'bottom', align: 'end', delayMs: 500,
        children: h('button', { type: 'button', className: 'nodo-icon-btn nodo-role-config', disabled: busyNow || state.active,
          'aria-label': `配置角色 ${item.name}`, onClick: () => onEditRole(item),
          'aria-pressed': editing?.profile?.id === item.id ? 'true' : undefined }, h(IconSlidersTwoOutlineRegular, { size: 16 })) }))
  }
  const backLabel = workflowNavigation ? '返回 Nodo 会话' : '返回普通空间'
  return h('aside', { className: 'nodo-rail', 'aria-label': workflowNavigation ? '工作流导航' : '角色与项目会话' },
    h('div', { className: 'nodo-rail-head' },
      h(Tooltip, { label: backLabel, side: 'bottom', delayMs: 500,
        children: h('button', { type: 'button', className: 'nodo-icon-btn nodo-visible', 'aria-label': backLabel,
          disabled: typeof layoutService?.selectPanel !== 'function', onClick: onBack }, h(IconChevronLeftOutlineRegular, { size: 16 })) }),
      h('span', { className: 'nodo-rail-title' }, h(NodoLogo)),
      h(Tooltip, { label: '设置', side: 'bottom', align: 'end', delayMs: 500,
        children: h('button', { type: 'button', className: 'nodo-icon-btn nodo-visible', 'aria-label': '设置', onClick: onSettings,
          'aria-pressed': editing?.kind === 'settings' ? 'true' : undefined }, h(IconSettingsOutlineRegular, { size: 16 })) })),
    workflowNavigation ?? h(Fragment, null,
      h(Button, { variant: 'outline', className: 'nodo-workflow-entry', onClick: onWorkflows, 'aria-label': runsWaiting ? 'Workflow（有待处理）' : 'Workflow' },
        h(IconPlanOutlineRegular, { size: 16 }), 'Workflow', runsWaiting && h(StateDot, { state: 'warning', size: 8 })),
    h('div', { className: 'nodo-rail-list' },
      h('section', { 'aria-label': '角色', className: 'nodo-roles' },
        sectionHead('角色', h(Tooltip, { label: '添加角色', side: 'bottom', align: 'end', delayMs: 500,
          children: h('button', { type: 'button', className: 'nodo-icon-btn nodo-visible', 'aria-label': '添加角色', disabled: busyNow, onClick: onNewRole }, h(IconPlusOutlineRegular, { size: 16 })) })),
        ...view.profiles.map(roleRow),
        !view.profiles.length && h('p', { className: 'nodo-rail-empty' }, '添加角色，开始协作')),
      h('section', { 'aria-label': '项目', className: 'nodo-projects' },
        sectionHead('项目', h(Fragment, null,
          h(Menu, {
            open: filterOpen, onClose: () => setFilterOpen(false), portal: true, selectedId: archivedView, align: 'end',
            items: Object.entries(ARCHIVED_VIEWS).map(([id, label]) => ({ id, label, icon: id === 'hide' ? h(IconArchiveOffOutlineRegular) : h(IconArchiveOutlineRegular) })),
            onSelect: id => { setFilterOpen(false); setArchivedView(id) },
            anchor: h('button', { type: 'button', className: 'nodo-icon-btn nodo-visible', 'aria-haspopup': 'menu', 'aria-expanded': filterOpen,
              'aria-label': '会话筛选', title: ARCHIVED_VIEWS[archivedView], 'data-active': archivedView !== 'hide' ? '' : undefined,
              onClick: () => setFilterOpen(open => !open) }, h(IconArchiveOutlineRegular, { size: 16 })),
          }),
          h(Tooltip, { label: '添加项目', side: 'bottom', align: 'end', delayMs: 500,
            children: h('button', { type: 'button', className: 'nodo-icon-btn nodo-visible', disabled: busyNow,
              'aria-label': '添加项目', onClick: onNewWorkspace }, h(IconProjectAddOutlineRegular, { size: 16 })) }))),
      workspace && h('div', { key: workspace.id },
        h('div', { className: 'nodo-project', 'data-menu': menuOpen ? 'open' : undefined }, searching || query
          ? h('div', { className: 'nodo-search' }, h(Input, {
            type: 'search', value: query, autoFocus: true, onChange: event => setQuery(event.target.value),
            onKeyDown: event => { if (event.key === 'Escape') { setQuery(''); setSearching(false) } },
            onBlur: () => { if (!query.trim()) { setQuery(''); setSearching(false) } },
            placeholder: '搜索当前项目会话…', 'aria-label': '搜索当前项目会话', className: 'nodo-search-input',
            icon: h(IconSearchOutlineRegular, { size: 16 }),
          }))
          : h(Fragment, null, workspacePicker({ workspaces: view.workspaces, workspace, running: runningWorkspaces, open: pickerOpen, setOpen: setPickerOpen, onSelect: onSelectWorkspace }),
          h('span', { className: 'nodo-row-actions' },
            h(Menu, {
              open: menuOpen, onClose: () => setMenuOpen(false), portal: true, closeOnPointerLeave: true,
              items: [
                { id: 'worktree', label: '创建工作树…', icon: h(IconBranchOutlineRegular), disabled: busyNow },
                { id: 'rename', label: '重命名', icon: h(IconEditOutlineRegular) },
                { id: 'delete', label: '删除工作区', icon: h(IconTrashOutlineRegular), danger: true },
              ],
              onSelect: id => {
                setMenuOpen(false)
                if (id === 'worktree') onNewWorktree()
                else if (id === 'rename') onRenameWorkspace(workspace)
                else if (id === 'delete') onDeleteWorkspace(workspace)
              },
              anchor: h('button', {
                type: 'button', className: 'nodo-row-action', 'aria-haspopup': 'menu', 'aria-expanded': menuOpen,
                'aria-label': `工作区“${workspace.name}”的操作`, disabled: busyNow,
                onClick: event => { event.stopPropagation(); setMenuOpen(open => !open) },
              }, h(IconEllipsisOutlineRegular)),
            }),
            h(Tooltip, {
              label: '搜索会话', side: 'bottom', align: 'end', delayMs: 500,
              children: h('button', {
                type: 'button', className: 'nodo-row-action', 'aria-label': '搜索当前项目会话',
                onClick: event => { event.stopPropagation(); setSearching(true) },
              }, h(IconSearchOutlineRegular)),
            }),
            h(Tooltip, {
              label: '新建工作树', side: 'bottom', align: 'end', delayMs: 500,
              children: h('button', {
                type: 'button', className: 'nodo-row-action',
                'aria-label': `从“${workspace.name}”创建工作树`, disabled: busyNow,
                onClick: event => { event.stopPropagation(); onNewWorktree() },
              }, h(IconBranchOutlineRegular)),
            }),
            h(Tooltip, {
              // No keycap: the host owns ⌘N at the app layer (it opens a native
              // session), so the panel's new-session is the button only.
              label: '新会话', side: 'bottom', align: 'end', delayMs: 500,
              children: h('button', {
                type: 'button', className: 'nodo-row-action',
                'aria-label': `在“${workspace.name}”中新建会话`, disabled: busyNow,
                onClick: event => { event.stopPropagation(); onNewSession(filterRole?.id ?? profile?.id) },
              }, h(IconNewChatOutlineRegular)),
            })))),
        h('div', { className: 'nodo-project', 'data-menu': roleOpen ? 'open' : undefined },
          h(Menu, {
            open: roleOpen, onClose: () => setRoleOpen(false), portal: true, selectedId: roleFilter ?? 'all', align: 'start', className: 'nodo-picker',
            items: [{ id: 'all', label: '全部角色', icon: h(IconUsersOutlineRegular) },
              ...view.profiles.map(item => ({ id: item.id, label: item.name, icon: h(RoleAvatar, { profile: item, size: 16 }) }))],
            onSelect: id => { setRoleOpen(false); setRoleFilter(id === 'all' ? null : id) },
            anchor: h('button', { type: 'button', className: 'nodo-project-select', 'aria-haspopup': 'menu',
              'aria-expanded': roleOpen, 'aria-label': `按角色筛选会话，当前 ${filterRole?.name ?? '全部角色'}`,
              onClick: event => { event.stopPropagation(); setRoleOpen(open => !open) } },
            h('span', { className: 'nodo-folder' }, filterRole ? h(RoleAvatar, { profile: filterRole, size: 16 }) : h(IconUsersOutlineRegular, { size: 16 })),
            h('span', { className: 'nodo-row-title' }, filterRole?.name ?? '全部角色'),
            h('span', { className: 'nodo-chevron', 'data-open': roleOpen ? '' : undefined }, h(IconChevronDownOutlineRegular, { size: 14 }))),
          })),
        h('div', { className: 'nodo-sessions' },
          draftRow,
          ...visible.map(({ role, session }) => h(SessionRow, { key: session.id, role, session, busy,
            current: session.id === sessionId && !editing, work: view.work[session.id],
            onSelect: () => onSelectSession(role, session.id), onArchive: archived => onArchiveSession(role, session.id, archived),
            onRename: () => onRenameSession(role, session), onPin: pinned => onPinSession(role, session.id, pinned) })),
          folded && h('button', { type: 'button', className: 'nodo-show-more', 'aria-expanded': expanded,
            onClick: () => setExpanded(open => !open) }, expanded ? '收起' : '显示更多'),
          !entries.length && !draftRow && h('p', { className: 'nodo-rail-empty nodo-session-empty', role: 'status' },
            search || filterRole ? '没有找到匹配的会话' : archivedView === 'only' ? '暂无已归档会话' : '暂无会话'))),
      !workspace && h('p', { className: 'nodo-rail-empty', role: 'status' }, '添加项目 workspace')))),
    readOnly && h('p', { className: 'nodo-rail-foot' }, h(Tag, { tone: 'neutral' }, '只读模式')))
}
