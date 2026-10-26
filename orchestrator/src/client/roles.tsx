import type { ReactNode } from './ui-shared.js'
import {
  h, Fragment, useState, useEffect, useRef, useSyncExternalStore, useStateView, call,
  Menu, Modal, Button, roleStateOf, layoutService, IconChevronRightOutlineRegular, IconDataOutlineRegular, IconEllipsisOutlineRegular,
  IconPlusOutlineRegular, IconTrashOutlineRegular, IconUsersOutlineRegular,
} from './ui-shared.js'
import { RoleAvatar } from './avatar.tsx'
import { RoleEditor } from './profile-dialogs.js'
import { engineDisplayName } from './engine-logos.js'
import { route } from '../../core/shared/route.js'
import AVATAR_TEMPLATES from '../../core/shared/avatar-templates.json'

export interface RoleTaskType { id?: string; name: string; when?: string }
interface RoleCard {
  id: string; name: string; engine?: string; role?: string; model?: string; lead?: boolean; hard?: Record<string, string>
  taskTypes?: string[]; avatarTemplate?: string; sessions?: { id: string }[]
}
interface EngineChoice { id: string; label?: string }
interface RolesView {
  profiles: RoleCard[]
  work?: Record<string, { active?: boolean } | undefined>
  taskTypes?: RoleTaskType[]
  prefs?: { enabledEngines?: string[] | null; rolePresets?: unknown[] | null } | null
  readOnly?: string | null
}

// The rail content the roles page publishes while its panel is active, the way
// the workflow page publishes its own navigation.
let sidebarContent: { view: 'roles'; content: ReactNode } | null = null
const sidebarListeners = new Set<() => void>()
export const rolesSidebarSnapshot = () => sidebarContent
export const rolesSubscribeSidebar = (listener: () => void) => { sidebarListeners.add(listener); return () => { sidebarListeners.delete(listener) } }
export const rolesPublishSidebar = (content: { view: 'roles'; content: ReactNode } | null) => {
  if (content === sidebarContent) return
  sidebarContent = content
  for (const listener of sidebarListeners) listener()
}

// Where the roster's 配置角色/添加 buttons want the page to land, written before
// the panel opens and read once by the page.
let rolesTarget: { profileId?: string } | null = null
const targetListeners = new Set<() => void>()
export const readRolesTarget = () => rolesTarget
export const subscribeRolesTarget = (listener: () => void) => { targetListeners.add(listener); return () => { targetListeners.delete(listener) } }
export const openRoles = (target: { profileId?: string } = {}) => {
  rolesTarget = target
  for (const listener of targetListeners) listener()
}
const consumeRolesTarget = () => {
  if (rolesTarget === null) return
  rolesTarget = null
  for (const listener of targetListeners) listener()
}

// Set while the page holds unsaved edits: the rail's view switches route
// through it so leaving asks before discarding.
let leaveGuard: ((action: () => void) => void) | null = null
export const rolesGuard = (action: () => void) => { if (leaveGuard) leaveGuard(action); else action() }

// The conversation page keeps drafts in memory and mirrors them to storage, so a
// deleted role's session drafts must leave that copy too or the next edit writes
// them back.
const draftRemovers = new Set<(sessionIds: string[]) => void>()
export const registerDraftRemover = (remover: (sessionIds: string[]) => void) => {
  draftRemovers.add(remover)
  return () => { draftRemovers.delete(remover) }
}

const TYPES_MAX = 20

const miss = () => <span className="nodo-roles-miss">无人承接</span>
const Grip = () => (
  <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
    <circle cx="3" cy="3" r="1.2" /><circle cx="7" cy="3" r="1.2" /><circle cx="3" cy="7" r="1.2" />
    <circle cx="7" cy="7" r="1.2" /><circle cx="3" cy="11" r="1.2" /><circle cx="7" cy="11" r="1.2" />
  </svg>
)

// The task-type catalog editor: the whole list is submitted, existing rows keep
// their id and new rows carry none, so core issues fresh ids for them.
export function TaskTypesEditor({ view, disabled, onDone, onDirtyChange }: {
  view: RolesView; disabled: boolean; onDone: () => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}) {
  const types = view.taskTypes ?? []
  const [draft, setDraft] = useState<RoleTaskType[]>(() => types.map(item => ({ ...item })))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState<RoleTaskType | null>(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(types)
  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty])
  // Core prunes a removed type from every card; only executors take work.
  const holders = (id?: string) => id !== undefined ? view.profiles.filter(profile => profile.taskTypes?.includes(id)) : []
  const takers = (id?: string) => holders(id).filter(profile => profile.lead !== true)
  const editRow = (index: number, changes: Partial<RoleTaskType>) =>
    setDraft(rows => rows.map((row, i) => i === index ? { ...row, ...changes } : row))
  // Confirming targets the row object itself, so a shifted list can never point
  // the confirm at another type; it closes once its row leaves the draft.
  const drop = (row: RoleTaskType) => setDraft(rows => rows.filter(item => item !== row))
  const save = async () => {
    setBusy(true); setError('')
    try {
      const saved = await call('task-types-update', { types: draft.map(row => row.id !== undefined
        ? { id: row.id, name: row.name, when: row.when ?? '' }
        : { name: row.name, when: row.when ?? '' }) })
      setDraft(saved.map((item: RoleTaskType) => ({ ...item })))
      await onDone()
    } catch (failure) { setError((failure as Error).message) }
    setBusy(false)
  }
  const discard = () => { setError(''); setDraft(types.map(item => ({ ...item }))) }
  const locked = disabled || busy
  return (
    <section className="nodo-types" aria-labelledby="nodo-types-title">
      <header className="nodo-roles-head">
        <h1 id="nodo-types-title">任务类型<span className="nodo-types-count">{`${draft.length} / ${TYPES_MAX}`}</span></h1>
        <Button variant="outline" disabled={locked || draft.length >= TYPES_MAX}
          onClick={() => setDraft(rows => [...rows, { name: '', when: '' }])}>添加类型</Button>
      </header>
      <div className="nodo-types-table">
        <div className="nodo-type-row nodo-type-row-head" aria-hidden>
          <span>名称</span><span>主控据此判断任务属于哪一类</span><span>承接角色</span><span />
        </div>
        {draft.map((row, index) => {
          const owners = takers(row.id)
          return (
            <div key={row.id ?? `new:${index}`} className="nodo-type-row">
              <input className="nodo-type-input" value={row.name} maxLength={20} placeholder="名称" aria-label="任务类型名称" disabled={locked}
                onChange={event => editRow(index, { name: event.target.value })} />
              <span className="nodo-type-when">
                <input className="nodo-type-input" value={row.when ?? ''} maxLength={200} placeholder="什么时候派这类任务" aria-label="任务类型说明" disabled={locked}
                  onChange={event => editRow(index, { when: event.target.value })} />
                <span className="nodo-dialog-count" aria-hidden>{(row.when ?? '').length}/200</span>
              </span>
              <span className="nodo-type-takers" title={owners.map(item => item.name).join('、') || undefined}>
                {owners.length ? owners.slice(0, 4).map(item => <RoleAvatar key={item.id} profile={item} size={22} />) : miss()}
                {owners.length > 4 && <span className="nodo-type-more">{`+${owners.length - 4}`}</span>}
              </span>
              <button type="button" className="nodo-type-remove" aria-label={`删除类型 ${row.name}`} disabled={locked}
                onClick={() => holders(row.id).length ? setConfirming(row) : drop(row)}><IconTrashOutlineRegular size={14} /></button>
              {confirming === row && (
                <div className="nodo-type-confirm" role="alert">
                  <span>{`将从 ${holders(row.id).map(item => item.name).join('、')} 上移除`}</span>
                  <Button variant="outline" size="sm" onClick={() => setConfirming(null)}>取消</Button>
                  <Button variant="outline" size="sm" className="nodo-dialog-danger" onClick={() => drop(row)}>删除</Button>
                </div>
              )}
            </div>
          )
        })}
        {!draft.length && <p className="nodo-dialog-hint">暂无任务类型</p>}
      </div>
      {error && <p className="nodo-dialog-error" role="alert">{error}</p>}
      {dirty && (
        <div className="nodo-types-bar" role="region" aria-label="未保存的修改">
          <Button variant="outline" disabled={busy} onClick={discard}>放弃</Button>
          <Button variant="primary" disabled={locked} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</Button>
        </div>
      )}
    </section>
  )
}

export function RolesPage({ view, readOnly, refresh }: { view: RolesView; readOnly: boolean; refresh: (force?: boolean) => Promise<void> }) {
  const target = useSyncExternalStore(subscribeRolesTarget, readRolesTarget)
  const [roleId, setRoleId] = useState<string | null>(() => target?.profileId && target.profileId !== 'new' ? target.profileId : null)
  const [typeOpen, setTypeOpen] = useState(false)
  const [confirm, setConfirm] = useState<{ action: () => void } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [menuId, setMenuId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropId, setDropId] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [adding, setAdding] = useState(() => target?.profileId === 'new')
  const [newName, setNewName] = useState('')
  const [newEngine, setNewEngine] = useState('')
  const [engines, setEngines] = useState<EngineChoice[] | null>(null)
  const [takesOpen, setTakesOpen] = useState<string | null>(null)
  // Task types a click just set on a row, shown until the saved view returns.
  const [pendingTypes, setPendingTypes] = useState<Record<string, string[]>>({})
  const [deleting, setDeleting] = useState<RoleCard | null>(null)
  const dirtyRef = useRef(false)
  const typedRef = useRef(false)
  const roles = view.profiles
  const types = view.taskTypes ?? []
  const leads = roles.filter(item => item.lead === true)
  const executors = roles.filter(item => item.lead !== true).map(item => pendingTypes[item.id] ? { ...item, taskTypes: pendingTypes[item.id] } : item)
  const creating = adding || executors.length === 0
  typedRef.current = newName.trim() !== ''
  const perform = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await action(); await refresh(true) } catch (failure) { setError((failure as Error).message) }
    finally { setBusy(false) }
  }
  // Positions are executor positions; leads keep their slots in the full order
  // profile-order needs.
  const reorder = async (from: number, to: number) => {
    if (from === to || to < 0 || to >= executors.length) return
    const moved = executors.map(item => item.id)
    const [id] = moved.splice(from, 1)
    moved.splice(to, 0, id)
    let next = 0
    const ids = roles.map(item => item.lead === true ? item.id : moved[next++])
    // A rejected order means the roster changed underneath us: resync the view
    // and ask for a retry instead of the endpoint's technical message.
    await perform(async () => {
      try { await call('profile-order', { ids }) } catch { await refresh(true); throw new Error('角色列表已变化，请重试') }
    })
  }
  const run = (action: () => void) => { setAdding(false); setNewName(''); setTakesOpen(null); setError(''); action() }
  const switchTo = (action: () => void) => { if (dirtyRef.current || typedRef.current) setConfirm({ action: () => run(action) }); else run(action) }
  const showOverview = () => { setTypeOpen(false); setRoleId(null) }
  const openRole = (id: string) => { setTypeOpen(false); setRoleId(id) }
  const startAdding = () => { showOverview(); setAdding(true) }
  useEffect(() => {
    leaveGuard = switchTo
    return () => { leaveGuard = null }
  }, [])
  useEffect(() => {
    if (!target) return
    consumeRolesTarget()
    switchTo(() => target.profileId && target.profileId !== 'new' ? openRole(target.profileId) : startAdding())
  }, [target])
  // The inline create row lists the engines the editor would offer a new role.
  useEffect(() => {
    if (!creating || engines !== null) return
    setEngines([])
    void call('engine-catalog').then((items: EngineChoice[]) => {
      const enabled = view.prefs?.enabledEngines ?? null
      const scoped = enabled !== null ? items.filter(item => enabled.includes(item.id)) : items
      const choices = scoped.length > 0 ? scoped : items
      setEngines(choices)
      setNewEngine(current => current || choices[0]?.id || '')
    }).catch(failure => setError((failure as Error).message))
  }, [creating, engines])
  useEffect(() => {
    if (takesOpen === null || typeof document === 'undefined') return
    const close = (event: Event) => { if (!(event.target as Element | null)?.closest?.('[data-takes-open]')) setTakesOpen(null) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [takesOpen])

  const savedRole = async (saved: { id: string }) => { await refresh(true); setRoleId(saved.id) }
  const deletedRole = async (item: { id: string; sessions?: { id: string }[] }) => {
    await call('profile-delete', { id: item.id })
    await refresh(true)
    // Drafts live per session; a deleted role's drafts would never be sent.
    const sessionIds = (item.sessions ?? []).map(session => session.id)
    for (const remove of draftRemovers) remove(sessionIds)
    try {
      const drafts = JSON.parse(localStorage.getItem('nodo.drafts') ?? '{}')
      for (const id of sessionIds) delete drafts[id]
      localStorage.setItem('nodo.drafts', JSON.stringify(drafts))
    } catch {}
    setRoleId(current => current === item.id ? null : current)
  }
  const typeNameOf = (id: string) => types.find(item => item.id === id)?.name ?? id
  const engineName = (role: RoleCard) => engineDisplayName({ id: role.engine ?? '' })
  const newAvatar = AVATAR_TEMPLATES[roles.length % AVATAR_TEMPLATES.length].id
  const createRole = (event: { preventDefault: () => void }) => {
    event.preventDefault()
    const name = newName.trim()
    if (!name || !newEngine || readOnly) return
    void perform(async () => {
      await call('profile-create', { name, engine: newEngine, avatarTemplate: newAvatar })
      setAdding(false); setNewName('')
    })
  }
  const cancelAdding = () => { setAdding(false); setNewName('') }
  // A row's task types save on every click; a refusal falls back to the saved card.
  const toggleType = async (role: RoleCard, id: string) => {
    const held = role.taskTypes ?? []
    const next = held.includes(id) ? held.filter(item => item !== id) : [...held, id]
    setPendingTypes(current => ({ ...current, [role.id]: next }))
    setError('')
    try { await call('profile-update', { id: role.id, changes: { taskTypes: next } }); await refresh(true) }
    catch (failure) { setError((failure as Error).message) }
    finally { setPendingTypes(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== role.id))) }
  }

  const createForm = (className: string, order?: number) => (
    <form className={className} aria-label="添加角色" onSubmit={createRole}
      onKeyDown={event => { if (event.key === 'Escape' && adding) cancelAdding() }}>
      {order !== undefined && <span className="nodo-roles-order">{order}</span>}
      <span className="nodo-roles-new-who">
        <RoleAvatar profile={{ avatarTemplate: newAvatar }} size={28} />
        <input className="nodo-dialog-input" autoFocus aria-label="名字" placeholder="名字" maxLength={40} value={newName}
          disabled={readOnly || busy} onChange={event => setNewName(event.target.value)} />
      </span>
      <select className="nodo-dialog-input nodo-dialog-select" aria-label="Agent" value={newEngine} disabled={readOnly || busy || !engines?.length}
        onChange={event => setNewEngine(event.target.value)}>
        {!engines?.length && <option value="">正在加载 Agent…</option>}
        {(engines ?? []).map(item => <option key={item.id} value={item.id}>{engineDisplayName(item)}</option>)}
      </select>
      <span className="nodo-roles-new-actions">
        {adding && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={cancelAdding}>取消</Button>}
        <Button type="submit" variant="primary" size="sm" disabled={readOnly || busy || !newName.trim() || !newEngine}>创建</Button>
      </span>
    </form>
  )
  const takesCell = (role: RoleCard, locked: boolean) => {
    const ids = role.taskTypes ?? []
    const open = takesOpen === role.id
    return (
      <span className="nodo-roles-takes" data-takes-open={open ? '' : undefined}>
        <button type="button" className="nodo-roles-takes-trigger" aria-haspopup="true" aria-expanded={open} disabled={locked || !types.length}
          aria-label={`承接任务 ${role.name}`} onClick={() => setTakesOpen(open ? null : role.id)}>
          {ids.length ? ids.map(typeNameOf).join('、') : <span className="nodo-roles-takes-empty">选择承接任务</span>}
        </button>
        {open && (
          <div className="nodo-roles-takes-pop" role="group" aria-label={`${role.name} 承接的任务类型`}
            onKeyDown={event => { if (event.key === 'Escape') setTakesOpen(null) }}>
            {types.map(type => (
              <label key={type.id} className="nodo-roles-takes-option" title={type.when || undefined}>
                <input type="checkbox" checked={ids.includes(type.id ?? '')} onChange={() => void toggleType(role, type.id ?? '')} />{type.name}
              </label>
            ))}
          </div>
        )}
      </span>
    )
  }
  const executorRow = (role: RoleCard, index: number) => {
    const state = roleStateOf(role, view)
    const held = busy || state.active === true
    const locked = readOnly || held
    return (
      <div key={role.id} className="nodo-roles-row" data-dragging={dragId === role.id ? '' : undefined} data-drop={dropId === role.id ? '' : undefined}
        draggable={!locked}
        onDragStart={event => { setDragId(role.id); event.dataTransfer.effectAllowed = 'move' }}
        onDragOver={event => { if (dragId !== null && dragId !== role.id && !locked) { event.preventDefault(); setDropId(role.id) } }}
        onDragLeave={() => setDropId(current => current === role.id ? null : current)}
        onDrop={event => { event.preventDefault(); const from = executors.findIndex(item => item.id === dragId); setDragId(null); setDropId(null); if (from >= 0) void reorder(from, index) }}
        onDragEnd={() => { setDragId(null); setDropId(null) }}>
        <span className="nodo-roles-order"><Grip />{index + 1}</span>
        <button type="button" className="nodo-roles-who-cell" disabled={held} title={role.name}
          onClick={() => switchTo(() => openRole(role.id))}>
          <RoleAvatar profile={role} size={28} running={state.active} />
          <span className="nodo-roles-copy">
            <span className="nodo-roles-name">{role.name}</span>
            {role.role && <span className="nodo-roles-sub">{role.role}</span>}
          </span>
        </button>
        <span className="nodo-roles-copy">
          <span>{engineName(role)}</span>
          <span className="nodo-roles-sub">{role.model || '默认模型'}</span>
        </span>
        {takesCell(role, locked)}
        <span className="nodo-roles-hard">{role.hard !== undefined ? '可接' : ''}</span>
        <Menu open={menuId === role.id} onClose={() => setMenuId(null)} portal closeOnPointerLeave
          items={[
            { id: 'up', label: '上移', disabled: locked || index === 0 },
            { id: 'down', label: '下移', disabled: locked || index === executors.length - 1 },
            { id: 'edit', label: '编辑', disabled: held },
            { id: 'delete', label: '删除角色', disabled: locked },
          ]}
          onSelect={(id: string) => {
            setMenuId(null)
            if (id === 'edit') switchTo(() => openRole(role.id))
            else if (id === 'delete') setDeleting(role)
            else void reorder(index, id === 'up' ? index - 1 : index + 1)
          }}
          anchor={<button type="button" className="nodo-row-action nodo-roles-more" aria-haspopup="menu" aria-expanded={menuId === role.id}
            aria-label={`更多操作 ${role.name}`} disabled={busy}
            onClick={event => { event.stopPropagation(); setMenuId(current => current === role.id ? null : role.id) }}>
            <IconEllipsisOutlineRegular size={16} /></button>} />
      </div>
    )
  }
  const who = (result: { miss?: boolean; profile?: RoleCard }) => result.profile
    ? <span className="nodo-roles-who"><RoleAvatar profile={result.profile} size={20} />{result.profile.name}</span>
    : miss()
  const plan = types.map(type => ({ type,
    routine: route({ type: type.id, hard: false }, executors), hard: route({ type: type.id, hard: true }, executors) }))
  const gaps = plan.reduce((count, row) => count + (row.routine.miss ? 1 : 0) + (row.hard.miss ? 1 : 0), 0)
  const routed = executors.some(item => (item.taskTypes ?? []).length > 0)

  const overview = (
    <div className="nodo-roles-overview">
      <header className="nodo-roles-head"><h1>角色</h1></header>
      <section className="nodo-roles-leads" aria-label="主控">
        {leads.length ? leads.map(lead => (
          <div key={lead.id} className="nodo-roles-lead">
            <span className="nodo-roles-lead-art"><RoleAvatar profile={lead} size={28} running={roleStateOf(lead, view).active} /></span>
            <span className="nodo-roles-copy nodo-roles-lead-copy">
              <span className="nodo-roles-name">{lead.name}<span className="nodo-roles-tag">主控</span></span>
              {lead.role && <span className="nodo-roles-sub">{lead.role}</span>}
            </span>
            <span className="nodo-roles-copy nodo-roles-lead-engine">
              <span>{engineName(lead)}</span>
              <span className="nodo-roles-sub">{lead.model || '默认模型'}</span>
            </span>
            <Button variant="outline" size="sm" disabled={busy || roleStateOf(lead, view).active === true}
              onClick={() => switchTo(() => openRole(lead.id))}>编辑</Button>
          </div>
        )) : <p className="nodo-roles-lead-none">还没有主控角色</p>}
      </section>
      {executors.length === 0 ? (
        <section className="nodo-roles-empty" aria-labelledby="nodo-roles-empty-title">
          <h2 id="nodo-roles-empty-title">给主控配一个执行角色</h2>
          <p>主控拆好任务后，会交给这里的角色去做</p>
          {createForm('nodo-roles-create')}
        </section>
      ) : (
        <Fragment>
          <section className="nodo-roles-section" aria-labelledby="nodo-roles-executors">
            <h2 id="nodo-roles-executors">执行角色</h2>
            <div className="nodo-roles-table">
              <div className="nodo-roles-row nodo-roles-row-head" aria-hidden>
                <span>顺序</span><span>角色</span><span>Agent</span><span>承接任务</span><span>难题</span><span />
              </div>
              {executors.map(executorRow)}
              {adding && createForm('nodo-roles-row nodo-roles-new', executors.length + 1)}
            </div>
            {!adding && (
              <button type="button" className="nodo-roles-add" disabled={readOnly || busy} onClick={() => switchTo(startAdding)}>
                <span className="nodo-roles-add-icon"><IconPlusOutlineRegular size={14} /></span>添加角色
              </button>
            )}
          </section>
          <section className="nodo-roles-section" aria-labelledby="nodo-roles-plan">
            <div className="nodo-roles-section-head">
              <h2 id="nodo-roles-plan">派活结果{routed && gaps > 0 && <span className="nodo-roles-gaps">{`${gaps} 处无人承接`}</span>}</h2>
              <button type="button" className="nodo-text-button" onClick={() => switchTo(() => setTypeOpen(true))}>管理任务类型</button>
            </div>
            {routed ? (
              <div className="nodo-roles-plan">
                <div className="nodo-roles-plan-row nodo-roles-row-head" aria-hidden><span>任务类型</span><span>常规交给</span><span>难题交给</span></div>
                {plan.map(row => (
                  <div key={row.type.id} className="nodo-roles-plan-row">
                    <span className="nodo-roles-name" title={row.type.when || undefined}>{row.type.name}</span>
                    {who(row.routine)}
                    {who(row.hard)}
                  </div>
                ))}
              </div>
            ) : <p className="nodo-roles-plan-none">还没有角色承接任务类型，主控会按角色名自己挑选</p>}
          </section>
        </Fragment>
      )}
    </div>
  )

  const sidebar = (
    <div className="nodo-roles-nav" role="navigation" aria-label="角色">
      <button type="button" className="nodo-role-types" aria-pressed={!typeOpen} onClick={() => switchTo(showOverview)}>
        <IconUsersOutlineRegular size={16} /><span className="nodo-role-types-label">全部角色</span><span className="nodo-role-types-count">{roles.length}</span>
      </button>
      <button type="button" className="nodo-role-types" aria-pressed={typeOpen} onClick={() => switchTo(() => setTypeOpen(true))}>
        <IconDataOutlineRegular size={16} /><span className="nodo-role-types-label">任务类型</span><span className="nodo-role-types-count">{types.length}</span>
      </button>
    </div>
  )
  useEffect(() => { rolesPublishSidebar({ view: 'roles', content: sidebar }) })
  const selected = roleId !== null ? roles.find(item => item.id === roleId) ?? null : null
  return (
    <section className="nodo-page nodo-roles" aria-label="角色管理">
      <div className="nodo-roles-chrome" aria-hidden />
      <div className="nodo-roles-body">
        <div className="nodo-role-dialog nodo-roles-main" data-screen={typeOpen ? 'types' : selected ? 'role' : 'overview'}>
          {typeOpen
            ? <TaskTypesEditor key={`types:${nonce}`} view={view} disabled={readOnly || busy} onDone={() => refresh(true)}
              onDirtyChange={value => { dirtyRef.current = value }} />
            : selected
              ? (
                <Fragment>
                  <nav className="nodo-roles-crumbs" aria-label="位置">
                    <button type="button" onClick={() => switchTo(showOverview)}>角色</button>
                    <IconChevronRightOutlineRegular size={12} />
                    <span aria-current="page">{selected.name}</span>
                  </nav>
                  <RoleEditor key={`${selected.id}:${nonce}`} profile={selected} roster={roles}
                    enabledEngines={view.prefs?.enabledEngines ?? null} savedIdentities={view.prefs?.rolePresets ?? null}
                    taskTypes={types} refresh={refresh} readOnly={readOnly}
                    onSaved={savedRole} onCancel={() => { setNonce(value => value + 1); showOverview() }} onDeleted={deletedRole}
                    onDirtyChange={value => { dirtyRef.current = value }} />
                </Fragment>
              )
              : overview}
          {error && <p className="nodo-error-line" role="alert">{error}</p>}
        </div>
      </div>
      {confirm && <Modal open title="放弃未保存的修改？" onClose={() => setConfirm(null)} closeLabel="关闭" className="nodo-dialog" footer={[
        <Button key="keep" variant="outline" onClick={() => setConfirm(null)}>继续编辑</Button>,
        <Button key="drop" variant="primary" onClick={() => { const { action } = confirm; setConfirm(null); action() }}>放弃修改</Button>,
      ]}>
        <p>当前修改尚未保存。</p>
      </Modal>}
      {deleting && <Modal open title={`删除角色“${deleting.name}”？`} onClose={() => setDeleting(null)} closeLabel="关闭" className="nodo-dialog" footer={[
        <Button key="keep" variant="outline" disabled={busy} onClick={() => setDeleting(null)}>取消</Button>,
        <Button key="delete" variant="outline" className="nodo-dialog-danger" disabled={busy}
          onClick={() => { const item = deleting; setDeleting(null); void perform(() => deletedRole(item)) }}>删除角色</Button>,
      ]}>
        <p>{`将把“${deleting.name}”及其 ${deleting.sessions?.length ?? 0} 个插件内会话记录移除。项目目录和文件会保留。`}</p>
      </Modal>}
    </section>
  )
}

export function RolesEntry() {
  const { view, error, refresh } = useStateView()
  useEffect(() => {
    if (document.querySelector('[data-sidebar-collapsed]')) layoutService?.toggleSidebar?.()
    return () => rolesPublishSidebar(null)
  }, [])
  if (!view) return <section className="nodo-page nodo-roles">{error || '正在读取角色…'}</section>
  return <RolesPage view={view} readOnly={!!view.readOnly} refresh={refresh} />
}

export const ROLES_CSS = `
.nodo-roles{overflow:hidden}
.nodo-roles-chrome{flex:none;height:var(--dsh-frame-top-clearance,0px);-webkit-app-region:drag}
.nodo-roles-body{display:flex;justify-content:center;flex:1;min-width:0;min-height:0;overflow-y:auto;padding:20px 32px 40px}
.nodo-roles-main{display:flex;flex-direction:column;gap:16px;flex:none;width:min(1080px,100%);height:fit-content}
.nodo-roles-main[data-screen=role]{width:min(800px,100%)}
.nodo-roles-nav{display:flex;flex-direction:column;gap:2px;flex:1;min-height:0}
.nodo-role-types{display:flex;align-items:center;gap:10px;flex:none;width:100%;height:36px;padding:0 10px;border:0;border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;line-height:20px;text-align:left;cursor:pointer}
.nodo-role-types:hover{background:var(--dsw-alias-interactive-bg-hover)}
.nodo-role-types[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px var(--dsw-alias-border-l2),0 0 0 .5px var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.nodo-role-types-label{flex:1;min-width:0}
.nodo-role-types-count{font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.nodo-roles-overview{display:flex;flex-direction:column;gap:20px}
.nodo-roles-head{display:flex;align-items:center;justify-content:space-between;gap:16px}
.nodo-roles-head h1{display:flex;align-items:baseline;gap:10px;margin:0;font-size:20px;font-weight:600;line-height:28px}
.nodo-roles-copy{display:flex;flex-direction:column;gap:2px;min-width:0;font-size:14px;line-height:20px}
.nodo-roles-copy>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-roles-name{display:flex;align-items:center;gap:8px;min-width:0;font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.nodo-roles-sub{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.nodo-roles-tag{flex:none;padding:0 8px;border-radius:999px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);font-size:12px;font-weight:400;line-height:20px}
.nodo-roles-leads{display:flex;flex-direction:column;gap:6px}
.nodo-roles-lead{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:8px 12px 8px 8px;border-radius:calc(var(--nodo-role-radius) + 8px);background:var(--dsw-specific-sidebar-nav-item-active-accent)}
.nodo-roles-lead-art{display:inline-flex;align-items:center;justify-content:center;flex:none;width:36px;height:36px;border-radius:var(--nodo-role-radius);background:var(--dsw-alias-bg-base)}
.nodo-roles-lead-copy{flex:1 1 260px}
.nodo-roles-lead .nodo-roles-name{font-weight:600}
.nodo-roles-lead-engine{align-items:flex-end;text-align:right}
.nodo-roles-lead-none{margin:0;padding:10px 14px;border:1px dashed var(--dsw-alias-border-l1);border-radius:calc(var(--nodo-role-radius) + 8px);color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.nodo-roles-empty{display:flex;flex-direction:column;align-items:center;gap:4px;padding:28px 24px 24px;border:1px dashed var(--dsw-alias-border-l1);border-radius:calc(var(--nodo-role-radius) + 10px);text-align:center}
.nodo-roles-empty h2{margin:0;font-size:16px;font-weight:600;line-height:24px}
.nodo-roles-empty p{max-width:420px;margin:0 0 12px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.nodo-roles-create{display:flex;flex-wrap:wrap;align-items:center;gap:8px;width:min(600px,100%);padding:8px;border-radius:calc(var(--nodo-role-radius) + 8px);background:var(--dsw-alias-bg-layer-1);text-align:left}
.nodo-roles-create>select{flex:0 1 180px}
.nodo-roles-new-who{display:flex;align-items:center;gap:10px;flex:1 1 220px;min-width:0}
.nodo-roles-new-who>.nodo-dialog-input{flex:1;min-width:0}
.nodo-roles-new-actions{display:flex;justify-content:flex-end;gap:8px;flex:none}
.nodo-roles-section{display:flex;flex-direction:column;gap:8px}
.nodo-roles-section h2{display:flex;align-items:center;gap:8px;margin:0;font-size:14px;font-weight:600;line-height:22px}
.nodo-roles-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.nodo-roles-table,.nodo-roles-plan,.nodo-types-table{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:calc(var(--nodo-role-radius) + 8px)}
.nodo-roles-row{display:grid;grid-template-columns:44px minmax(0,1.4fr) minmax(0,1fr) minmax(0,1.4fr) 40px 28px;align-items:center;gap:12px;min-height:48px;padding:4px 8px 4px 6px}
.nodo-roles-row+.nodo-roles-row,.nodo-roles-plan-row+.nodo-roles-plan-row,.nodo-type-row+.nodo-type-row{border-top:1px solid var(--dsw-alias-border-l2)}
.nodo-roles-row-head{min-height:32px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.nodo-roles-row[data-dragging]{opacity:.4}
.nodo-roles-row[data-drop]{box-shadow:inset 0 2px 0 var(--dsw-alias-state-business-primary)}
.nodo-roles-order{display:inline-flex;align-items:center;gap:8px;padding-left:4px;color:var(--dsw-alias-label-tertiary);font-size:13px;font-variant-numeric:tabular-nums}
.nodo-roles-row[draggable=true] .nodo-roles-order{cursor:grab}
.nodo-roles-who-cell{display:flex;align-items:center;gap:8px;min-width:0;margin:-4px;padding:4px;border:0;border-radius:var(--nodo-role-radius);background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer}
.nodo-roles-who-cell:hover:not(:disabled) .nodo-roles-name{text-decoration:underline}
.nodo-roles-who-cell:disabled{cursor:default}
.nodo-roles-takes{position:relative;min-width:0}
.nodo-roles-takes-trigger{max-width:calc(100% + 8px);height:28px;margin-left:-8px;padding:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;border-radius:var(--nodo-role-radius);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}
.nodo-roles-takes-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-roles-takes-trigger:disabled{cursor:default}
.nodo-roles-takes-empty{color:var(--dsw-alias-state-business-primary)}
.nodo-roles-takes-pop{position:absolute;z-index:20;top:calc(100% + 4px);left:-8px;display:flex;flex-direction:column;min-width:200px;max-height:280px;overflow-y:auto;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:calc(var(--nodo-role-radius) + 4px);background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv2)}
.nodo-roles-takes-option{display:flex;align-items:center;gap:8px;min-height:32px;padding:0 8px;border-radius:var(--nodo-role-radius);font-size:13px;line-height:20px;cursor:pointer}
.nodo-roles-takes-option:hover{background:var(--dsw-alias-interactive-bg-hover)}
.nodo-roles-takes-option input{margin:0;accent-color:var(--dsw-alias-state-business-primary)}
.nodo-roles-hard{color:var(--dsw-alias-label-secondary);font-size:13px}
.nodo-roles-row .nodo-roles-more{width:28px;height:28px;border-radius:var(--nodo-role-radius)}
.nodo-roles-row .nodo-roles-more:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-roles-new{border-radius:0 0 calc(var(--nodo-role-radius) + 7px) calc(var(--nodo-role-radius) + 7px);background:var(--dsw-alias-bg-layer-1)}
.nodo-roles-new>.nodo-roles-new-actions{grid-column:4/-1}
.nodo-roles-add{display:flex;align-items:center;gap:8px;width:fit-content;height:32px;padding:0 10px 0 6px;border:0;border-radius:var(--nodo-role-radius);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;line-height:20px;cursor:pointer}
.nodo-roles-add:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.nodo-roles-add-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;border:1px dashed var(--dsw-alias-border-l1);border-radius:50%}
.nodo-roles-gaps{padding:0 8px;border-radius:999px;background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);font-size:12px;font-weight:400;line-height:20px}
.nodo-roles-plan-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));align-items:center;gap:12px;min-height:36px;padding:6px 12px;font-size:13px;line-height:20px}
.nodo-roles-who{display:inline-flex;align-items:center;gap:8px;min-width:0;overflow:hidden;white-space:nowrap}
.nodo-roles-miss{color:var(--dsw-alias-state-warn-primary);font-size:13px}
.nodo-roles-plan-none{margin:0;padding:10px 12px;border-radius:calc(var(--nodo-role-radius) + 8px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.nodo-text-button{height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:13px;cursor:pointer}
.nodo-text-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-text-button:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.nodo-roles-crumbs{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.nodo-roles-crumbs button{padding:0;border:0;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}
.nodo-roles-crumbs button:hover{color:var(--dsw-alias-label-primary)}
.nodo-roles-crumbs [aria-current]{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.nodo-types{display:flex;flex-direction:column;gap:16px}
.nodo-types-count{color:var(--dsw-alias-label-tertiary);font-size:13px;font-weight:400;font-variant-numeric:tabular-nums}
.nodo-type-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2.2fr) minmax(0,1fr) 32px;align-items:center;gap:8px;min-height:40px;padding:2px 6px}
.nodo-type-row-head{min-height:32px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.nodo-type-row-head>span{padding:0 9px}
.nodo-type-input{width:100%;height:32px;padding:0 8px;border:1px solid transparent;border-radius:var(--nodo-role-radius);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:20px}
.nodo-type-input::placeholder{color:var(--dsw-alias-label-tertiary);opacity:1}
.nodo-type-input:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-type-input:focus{outline:0;border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-base)}
.nodo-type-when{position:relative;min-width:0}
.nodo-type-when>.nodo-type-input{padding-right:56px;color:var(--dsw-alias-label-secondary);font-size:13px}
.nodo-type-when>.nodo-dialog-count{display:none;right:10px;bottom:6px}
.nodo-type-when:focus-within>.nodo-dialog-count{display:block}
.nodo-type-takers{display:flex;align-items:center;min-width:0;padding-left:9px}
.nodo-type-takers>.nodo-avatar+.nodo-avatar{margin-left:-6px}
.nodo-type-more{margin-left:6px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.nodo-type-remove{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:var(--nodo-role-radius);background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.nodo-type-remove:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary)}
.nodo-type-confirm{grid-column:1/-1;display:flex;align-items:center;gap:8px;padding:6px 6px 6px 12px;border-radius:calc(var(--nodo-role-radius) + 2px);background:var(--dsw-alias-bg-layer-1)}
.nodo-type-confirm>span{flex:1;min-width:0;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}
.nodo-types .nodo-dialog-hint{padding:16px}
.nodo-types-bar{position:sticky;bottom:24px;align-self:center;display:flex;gap:8px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:calc(var(--nodo-role-radius) + 8px);background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv2)}
@media(max-width:720px){.nodo-roles-body{padding:16px 12px 32px}.nodo-roles-row{grid-template-columns:40px minmax(0,1fr) minmax(0,1fr) 28px}.nodo-roles-row>:nth-child(3),.nodo-roles-row>:nth-child(5){display:none}.nodo-roles-new>.nodo-roles-new-actions{grid-column:auto}}
`
