import type { ReactNode } from './ui-shared.js'
import {
  h, Fragment, useState, useEffect, useRef, useSyncExternalStore, useStateView, call,
  Modal, Button, roleStateOf, WARN_INK, layoutService, IconChevronRightOutlineRegular, IconChecklistOutlineRegular, IconEditOutlineRegular,
  IconPlusOutlineRegular, IconTrashOutlineRegular, IconUsersOutlineRegular,
} from './ui-shared.js'
import { RoleAvatar } from './avatar.tsx'
import { Field, RoleEditor } from './profile-dialogs.js'
import { PermissionSelect, permissionForEngine, usePermissionChange } from './composer.js'
import { modelChoices, thinkingAfterModelChange, thinkingOptions } from './model-options.js'
import type { ModelChoice } from './model-options.js'
import { engineDisplayName } from './engine-logos.js'
import { route } from '../../core/shared/route.js'
import { LEAD_ENGINES } from '../../core/shared/lead.js'
import AVATAR_TEMPLATES from '../../core/shared/avatar-templates.json'
import ROLE_PRESETS from '../../core/shared/role-presets.json'

export interface RoleTaskType { id?: string; name: string; when?: string }
interface RoleCard {
  id: string; name: string; identity?: string; instructions?: string; deletedAt?: number; engine?: string; role?: string; model?: string; thinking?: string; lead?: boolean; fallback?: boolean; hard?: Record<string, string>
  taskTypes?: string[]; avatarTemplate?: string; permission?: string; sessions?: { id: string; draftedAt?: number; briefSent?: boolean }[]
}
interface EngineChoice { id: string; label?: string; capabilities?: { permissionModes?: string[] }; catalog?: { models?: ModelChoice[]; defaultModel?: string } }
interface RolePreset { name: string; role: string; instructions: string }
interface RolesView {
  profiles: RoleCard[]
  work?: Record<string, { active?: boolean } | undefined>
  taskTypes?: RoleTaskType[]
  prefs?: { enabledEngines?: string[] | null; rolePresets?: RolePreset[] | null } | null
  readOnly?: string | null
}

// The rail content the roles page publishes while its panel is active.
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
  const holders = (id?: string) => id !== undefined ? view.profiles.filter(profile => !profile.deletedAt && profile.taskTypes?.includes(id)) : []
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
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropId, setDropId] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [adding, setAdding] = useState<'lead' | 'executor' | null>(() => target?.profileId === 'new' ? 'executor' : null)
  const [newName, setNewName] = useState('')
  const [newIdentity, setNewIdentity] = useState('')
  const [newEngine, setNewEngine] = useState('')
  const [newPermission, setNewPermission] = useState<string | undefined>(undefined)
  const [engines, setEngines] = useState<EngineChoice[] | null>(null)
  const [takesOpen, setTakesOpen] = useState<string | null>(null)
  // Task types a click just set on a row, shown until the saved view returns.
  const [pendingTypes, setPendingTypes] = useState<Record<string, string[]>>({})
  const [pendingHard, setPendingHard] = useState<Record<string, Record<string, string> | null>>({})
  const [pendingPermission, setPendingPermission] = useState<Record<string, string>>({})
  const { pick: choosePermission, confirmation: permissionConfirmation } = usePermissionChange(readOnly || busy)
  const [deleting, setDeleting] = useState<RoleCard | null>(null)
  const dirtyRef = useRef(false)
  const typedRef = useRef(false)
  const roles = view.profiles.filter(role => !role.deletedAt)
  const types = view.taskTypes ?? []
  const leads = roles.filter(item => item.lead === true)
  const executors = roles.filter(item => item.lead !== true).map(item => ({ ...item,
    taskTypes: pendingTypes[item.id] ?? item.taskTypes,
    hard: Object.hasOwn(pendingHard, item.id) ? pendingHard[item.id] ?? undefined : item.hard,
  }))
  const createKind = adding ?? (!executors.length ? 'executor' : null)
  typedRef.current = newName.trim() !== '' || newIdentity.trim() !== ''
  // The engine catalog answers after a click may have switched the create row kind.
  const addingRef = useRef(createKind)
  addingRef.current = createKind
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
  const run = (action: () => void) => { setAdding(null); setNewName(''); setNewIdentity(''); setNewPermission(undefined); setTakesOpen(null); setError(''); action() }
  const switchTo = (action: () => void) => { if (dirtyRef.current || typedRef.current) setConfirm({ action: () => run(action) }); else run(action) }
  const showOverview = () => { setTypeOpen(false); setRoleId(null) }
  const openRole = (id: string) => { setTypeOpen(false); setRoleId(id) }
  const startAdding = (kind: 'lead' | 'executor' = 'executor') => {
    showOverview()
    addingRef.current = kind
    setAdding(kind)
    // A lead row starts on a whitelisted engine; the executor default may not be one.
    if (kind === 'lead') setNewEngine(current => LEAD_ENGINES.includes(current) ? current
      : creationEngines(engines ?? []).find(item => LEAD_ENGINES.includes(item.id))?.id ?? '')
  }
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
    if (engines !== null) return
    setEngines([])
    void call('engine-catalog').then((items: EngineChoice[]) => {
      setEngines(items)
      const choices = creationEngines(items)
      // A lead row opened while the catalog loaded only accepts whitelisted engines.
      const first = choices.find(item => addingRef.current !== 'lead' || LEAD_ENGINES.includes(item.id))
      setNewEngine(current => current || first?.id || '')
    }).catch(failure => setError((failure as Error).message))
  }, [engines])
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
  const creationEngines = (items: EngineChoice[]) => {
    const enabled = view.prefs?.enabledEngines ?? null
    const scoped = enabled !== null ? items.filter(item => enabled.includes(item.id)) : items
    return scoped.length ? scoped : items
  }
  const newAvatar = AVATAR_TEMPLATES[roles.length % AVATAR_TEMPLATES.length].id
  // The lead row only offers engines wired to lead dispatch.
  const kindEngines = creationEngines(engines ?? []).filter(item => createKind !== 'lead' || LEAD_ENGINES.includes(item.id))
  const newEngineAvailable = kindEngines.some(item => item.id === newEngine)
  const newEngineInfo = engines?.find(item => item.id === newEngine)
  const newPermissionValue = permissionForEngine(newEngineInfo, newPermission)
  const createRole = (event: { preventDefault: () => void }) => {
    event.preventDefault()
    const name = newName.trim()
    if (!name || !newEngineAvailable || readOnly) return
    const identity = createKind === 'lead' ? 'leader' : newIdentity
    const preset = createKind === 'lead' ? ROLE_PRESETS.find(item => item.name === 'leader')
      : [...ROLE_PRESETS.filter(item => item.name !== 'leader'), ...(view.prefs?.rolePresets ?? [])].find(item => item.name === identity)
    void perform(async () => {
      await call('profile-create', { name, engine: newEngine, permission: newPermissionValue, avatarTemplate: newAvatar, identity,
        ...(createKind === 'lead' ? { lead: true } : {}),
        ...(preset ? { role: preset.role, instructions: preset.instructions } : {}),
      })
      setAdding(null); setNewName(''); setNewIdentity(''); setNewPermission(undefined)
    })
  }
  const cancelAdding = () => { setAdding(null); setNewName(''); setNewIdentity(''); setNewPermission(undefined) }
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
  const updateHard = async (role: RoleCard, hard: Record<string, string> | null) => {
    setPendingHard(current => ({ ...current, [role.id]: hard }))
    setError('')
    try { await call('profile-update', { id: role.id, changes: { hard } }); await refresh(true) }
    catch (failure) { setError((failure as Error).message) }
    finally { setPendingHard(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== role.id))) }
  }
  const updatePermission = async (role: RoleCard, permission: string) => {
    setPendingPermission(current => ({ ...current, [role.id]: permission }))
    setError('')
    try { await call('profile-update', { id: role.id, changes: { permission } }); await refresh(true) }
    catch (failure) { setError((failure as Error).message) }
    finally { setPendingPermission(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== role.id))) }
  }
  const permissionCell = (role: RoleCard, locked: boolean) => (
    <PermissionSelect modes={engines?.find(item => item.id === role.engine)?.capabilities?.permissionModes?.filter(mode => role.lead !== true || mode !== 'plan')}
      value={pendingPermission[role.id] ?? role.permission} className="nodo-roles-permission" label={`权限 ${role.name}`}
      disabled={locked || Object.hasOwn(pendingPermission, role.id)}
      onChange={(permission: string) => choosePermission(permission, role.permission, (next: string) => void updatePermission(role, next))} />
  )

  const identityCell = (role: RoleCard) => <span className="nodo-tag nodo-roles-identity" title={role.identity} data-empty={!role.identity ? '' : undefined}>{role.identity || (role.instructions ? '自定义' : '—')}</span>
  const createForm = (className: string, order?: number) => (
    <form className={className} aria-label={createKind === 'lead' ? '添加主控' : '添加角色'} onSubmit={createRole}
      onKeyDown={event => { if (event.key === 'Escape' && adding !== null) cancelAdding() }}>
      {order !== undefined && <span className="nodo-roles-order">{order}</span>}
      <span className="nodo-roles-new-who">
        <RoleAvatar profile={{ avatarTemplate: newAvatar }} size={28} />
        <input className="nodo-dialog-input" autoFocus aria-label="名字" placeholder="名字" maxLength={40} value={newName}
          disabled={readOnly || busy} onChange={event => setNewName(event.target.value)} />
      </span>
      {createKind === 'lead' ? identityCell({ id: '', name: '', identity: 'leader' }) : (
        <input className="nodo-dialog-input nodo-role-identity" aria-label="身份" placeholder="身份" maxLength={40} value={newIdentity}
          disabled={readOnly || busy} onChange={event => setNewIdentity(event.target.value)} />
      )}
      <select className="nodo-dialog-input nodo-dialog-select" aria-label="Agent" value={newEngine} disabled={readOnly || busy || !engines?.length}
        onChange={event => { setNewEngine(event.target.value); setNewPermission(undefined) }}>
        {!engines?.length && <option value="">正在加载 Agent…</option>}
        {kindEngines.map(item => <option key={item.id} value={item.id}>{engineDisplayName(item)}</option>)}
      </select>
      <PermissionSelect modes={newEngineInfo?.capabilities?.permissionModes?.filter(mode => createKind !== 'lead' || mode !== 'plan')} value={newPermissionValue}
        disabled={readOnly || busy} onChange={(permission: string) => choosePermission(permission, newPermissionValue, setNewPermission)} />
      <span className="nodo-roles-new-actions">
        {(createKind === 'lead' ? leads.length > 0 : executors.length > 0) && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={cancelAdding}>取消</Button>}
        <Button type="submit" variant="primary" size="sm" disabled={readOnly || busy || !newName.trim() || !newEngineAvailable}>创建</Button>
      </span>
    </form>
  )
  const takesCell = (role: RoleCard, locked: boolean) => {
    const ids = role.taskTypes ?? []
    const labels = [...ids.map(typeNameOf), ...(leads.length && role.fallback ? ['兜底'] : [])]
    const open = takesOpen === role.id
    const saving = locked || Object.hasOwn(pendingHard, role.id) || Object.hasOwn(pendingTypes, role.id)
    const catalog = engines?.find(item => item.id === role.engine)?.catalog
    const models = catalog?.models ?? []
    const hard = role.hard
    const { selected: hardSelected, options } = modelChoices(models, hard?.model, role.model || catalog?.defaultModel)
    const changeHard = (key: string, value: string) => {
      const next = { ...hard, [key]: value }
      if (key === 'model') next.thinking = thinkingAfterModelChange(models, value || role.model || catalog?.defaultModel, hard?.thinking)
      void updateHard(role, Object.fromEntries(Object.entries(next).filter(([, setting]) => setting)))
    }
    return (
      <span className="nodo-roles-takes" data-takes-open={open ? '' : undefined}>
        <button type="button" className="nodo-roles-takes-trigger" aria-haspopup="true" aria-expanded={open} disabled={locked}
          aria-label={`承接任务 ${role.name}`} onClick={() => setTakesOpen(open ? null : role.id)}>
          {labels.length ? labels.join('、') : <span className="nodo-roles-takes-empty">选择承接任务</span>}
        </button>
        {open && (
          <div className="nodo-roles-takes-pop" role="group" aria-label={`${role.name} 承接的任务类型`}
            onKeyDown={event => { if (event.key === 'Escape') setTakesOpen(null) }}>
            {types.map(type => (
              <label key={type.id} className="nodo-roles-takes-option" title={type.when || undefined}>
                <input type="checkbox" checked={ids.includes(type.id ?? '')} disabled={saving} onChange={() => void toggleType(role, type.id ?? '')} />{type.name}
              </label>
            ))}
            {leads.length > 0 && <label className="nodo-roles-takes-option">
              <input type="checkbox" aria-label="兜底" checked={role.fallback === true} disabled={saving || role.fallback === true}
                onChange={() => void perform(async () => { await call('profile-update', { id: role.id, changes: { fallback: true } }) })} />
              <span>兜底<small>没有角色承接的任务交给它</small></span>
            </label>}
            <div className="nodo-roles-hard-settings">
              <label className="nodo-roles-takes-option">
                <input type="checkbox" role="switch" aria-label="可接难题" checked={hard !== undefined} disabled={saving}
                  onChange={event => void updateHard(role, event.target.checked ? {} : null)} />
                <span>可接难题<small>主控判为难题时派给它，可另选模型和思考档位</small></span>
              </label>
              {hard !== undefined && <Fragment>
                <Field label="难题模型">
                  <select className="nodo-dialog-input nodo-dialog-select" aria-label="难题模型" value={hard.model ?? ''} disabled={saving}
                    onChange={event => changeHard('model', event.target.value)}>
                    <option value="">默认</option>
                    {options}
                  </select>
                </Field>
                <Field label="难题思考档位">
                  <select className="nodo-dialog-input nodo-dialog-select" aria-label="难题思考档位" value={hard.thinking ?? ''} disabled={saving}
                    onChange={event => changeHard('thinking', event.target.value)}>
                    <option value="">默认</option>
                    {thinkingOptions(hardSelected, hard.thinking)}
                  </select>
                </Field>
              </Fragment>}
            </div>
          </div>
        )}
      </span>
    )
  }
  const roleActions = (role: RoleCard, held: boolean, locked: boolean) => {
    const running = roleStateOf(role, view).active === true ? '角色运行中，结束后再修改' : undefined
    return <span className="nodo-roles-actions">
      <button type="button" className="nodo-row-action" aria-label={`编辑 ${role.name}`} disabled={held} title={held ? running : undefined}
        onClick={() => switchTo(() => openRole(role.id))}><IconEditOutlineRegular size={16} /></button>
      <button type="button" className="nodo-row-action nodo-roles-delete" aria-label={`删除 ${role.name}`}
        disabled={locked || !!deleteReason(role)} title={deleteReason(role) ?? (locked ? running : undefined)}
        onClick={() => setDeleting(role)}><IconTrashOutlineRegular size={16} /></button>
    </span>
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
        onDrop={event => { event.preventDefault(); const from = executors.findIndex(item => item.id === dragId); setDragId(null); setDropId(null); if (!locked && from >= 0 && !roleStateOf(executors[from], view).active) void reorder(from, index) }}
        onDragEnd={() => { setDragId(null); setDropId(null) }}>
        <span className="nodo-roles-order" role="button" tabIndex={locked ? -1 : 0} aria-disabled={locked}
          aria-label={`调整 ${role.name} 顺序`} title="Alt+↑ / Alt+↓ 调整顺序"
          onKeyDown={event => {
            if (!locked && event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
              event.preventDefault(); void reorder(index, index + (event.key === 'ArrowUp' ? -1 : 1))
            }
          }}><Grip />{index + 1}</span>
        <button type="button" className="nodo-roles-who-cell" disabled={held} title={role.name}
          onClick={() => switchTo(() => openRole(role.id))}>
          <RoleAvatar profile={role} size={28} running={state.active} />
          <span className="nodo-roles-copy">
            <span className="nodo-roles-name">{role.name}</span>
            {role.role && <span className="nodo-roles-sub">{role.role}</span>}
          </span>
        </button>
        {identityCell(role)}
        <span className="nodo-roles-copy">
          <span>{engineName(role)}</span>
          <span className="nodo-roles-sub">{role.model || '默认模型'}</span>
        </span>
        {permissionCell(role, locked)}
        {takesCell(role, locked)}
        <span className="nodo-roles-hard">{role.hard !== undefined ? '可接' : ''}</span>
        {roleActions(role, held, locked)}
      </div>
    )
  }
  const fallback = executors.find(role => role.fallback === true)
  const plan = types.map(type => ({ type,
    routine: route({ type: type.id, hard: false }, executors, fallback), hard: route({ type: type.id, hard: true }, executors, fallback) }))
  const routineGaps = plan.filter(row => row.routine.miss).map(row => row.type.name).join('、')
  const hardGaps = plan.filter(row => !row.routine.miss && row.hard.miss).map(row => row.type.name).join('、')
  const fallbackTypes = plan.filter(row => row.routine.by === 'fallback').map(row => row.type.name)
  const deleteReason = (role: RoleCard) => leads.length > 0 && role.lead !== true && executors.length === 1 ? '主控至少需要一个执行角色' : undefined
  const deleteHint = (role: RoleCard) => leads.length > 0 && role.fallback && executors.some(item => item.id !== role.id)
    ? `兜底将转给「${executors.find(item => item.id !== role.id)?.name}」。` : undefined

  const overview = (
    <div className="nodo-roles-overview">
      <header className="nodo-roles-head"><h1>角色</h1></header>
      <section className="nodo-roles-section" aria-labelledby="nodo-roles-leads">
        <div className="nodo-roles-section-head">
          <h2 id="nodo-roles-leads">主控</h2>
          {createKind !== 'lead' && <button type="button" className="nodo-roles-add" disabled={readOnly || busy || !executors.length} title={!executors.length ? '先添加执行角色' : undefined}
            onClick={() => switchTo(() => startAdding('lead'))}><IconPlusOutlineRegular size={14} />添加主控</button>}
        </div>
        <div className="nodo-roles-table">
          <div className="nodo-roles-lead nodo-roles-row-head" aria-hidden><span>角色</span><span>身份</span><span>Agent</span><span>权限</span><span /></div>
          {leads.map(lead => (
            <div key={lead.id} className="nodo-roles-lead">
              <span className="nodo-roles-who-cell">
                <RoleAvatar profile={lead} size={28} running={roleStateOf(lead, view).active} />
                <span className="nodo-roles-copy">
                  <span className="nodo-roles-name">{lead.name}</span>
                  {lead.role && <span className="nodo-roles-sub">{lead.role}</span>}
                </span>
              </span>
              {identityCell(lead)}
              <span className="nodo-roles-copy">
                <span>{engineName(lead)}</span>
                <span className="nodo-roles-sub">{lead.model || '默认模型'}</span>
              </span>
              {permissionCell(lead, readOnly || busy || roleStateOf(lead, view).active === true)}
              {roleActions(lead, busy || roleStateOf(lead, view).active === true, readOnly || busy || roleStateOf(lead, view).active === true)}
            </div>
          ))}
          {createKind === 'lead' && createForm('nodo-roles-lead nodo-roles-new')}
        </div>
      </section>
      {executors.length === 0 ? (
        <section className="nodo-roles-empty" aria-labelledby="nodo-roles-empty-title">
          <h2 id="nodo-roles-empty-title">{leads.length ? '给主控配一个执行角色' : '添加第一个角色'}</h2>
          <p>{leads.length ? '主控拆好任务后，会交给这里的角色去做' : '选择 Agent，创建角色后即可对话'}</p>
          {createKind === 'executor' ? createForm('nodo-roles-create') : <button type="button" className="nodo-roles-add" disabled={readOnly || busy}
            onClick={() => switchTo(startAdding)}><IconPlusOutlineRegular size={14} />添加角色</button>}
        </section>
      ) : (
        <Fragment>
          <section className="nodo-roles-section" aria-labelledby="nodo-roles-executors">
            <div className="nodo-roles-section-head">
              <h2 id="nodo-roles-executors">执行角色</h2>
              {createKind !== 'executor' && <button type="button" className="nodo-roles-add" disabled={readOnly || busy}
                onClick={() => switchTo(startAdding)}><IconPlusOutlineRegular size={14} />添加角色</button>}
            </div>
            <div className="nodo-roles-table">
              <div className="nodo-roles-row nodo-roles-row-head" aria-hidden>
                <span>顺序</span><span>角色</span><span>身份</span><span>Agent</span><span>权限</span><span>承接任务</span><span>难题</span><span />
              </div>
              {executors.map(executorRow)}
              {createKind === 'executor' && createForm('nodo-roles-row nodo-roles-new', executors.length + 1)}
            </div>
          </section>
        </Fragment>
      )}
      {leads.length > 0 && (routineGaps || hardGaps || fallbackTypes.length > 0) && <div className="nodo-roles-gap-note" role="status">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <path d="M12 3 2 21h20L12 3Z" /><path d="M12 9v5m0 3v1" />
          </svg>
          <div>{routineGaps && <p>{`${routineGaps}没有角色承接`}</p>}
            {fallbackTypes.map(name => <p key={name}>{`${name}没有角色承接，由「${fallback?.name}」兜底`}</p>)}
            {hardGaps && <p>{`${hardGaps}没有可接难题的角色`}</p>}</div>
        </div>}
    </div>
  )

  const sidebar = (
    <div className="nodo-roles-nav" role="navigation" aria-label="角色">
      <button type="button" className="nodo-role-types" aria-pressed={!typeOpen} onClick={() => switchTo(showOverview)}>
        <IconUsersOutlineRegular size={16} /><span className="nodo-role-types-label">全部角色</span><span className="nodo-role-types-count">{roles.length}</span>
      </button>
      <button type="button" className="nodo-role-types" aria-pressed={typeOpen} onClick={() => switchTo(() => setTypeOpen(true))}>
        <IconChecklistOutlineRegular size={16} /><span className="nodo-role-types-label">任务类型</span><span className="nodo-role-types-count">{types.length}</span>
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
                  <RoleEditor key={`${selected.id}:${nonce}`} profile={selected}
                    deleteReason={deleteReason(selected)} deleteHint={deleteHint(selected)}
                    enabledEngines={view.prefs?.enabledEngines ?? null} savedIdentities={view.prefs?.rolePresets ?? null}
                    refresh={refresh} readOnly={readOnly}
                    onSaved={savedRole} onCancel={() => { setNonce(value => value + 1); showOverview() }} onDeleted={deletedRole}
                    onDirtyChange={value => { dirtyRef.current = value }} />
                </Fragment>
              )
              : overview}
          {error && <p className="nodo-error-line" role="alert">{error}</p>}
        </div>
      </div>
      {permissionConfirmation}
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
        <p>{`将删除角色“${deleting.name}”，其 ${deleting.sessions?.filter(session => !session.draftedAt || session.briefSent).length ?? 0} 个会话会自动归档，可在「已移除」中查看。项目目录和文件会保留。`}</p>
        {deleteHint(deleting) && <p>{deleteHint(deleting)}</p>}
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
.nodo-roles-body{display:flex;flex:1;min-width:0;min-height:0;overflow:auto;padding:20px 32px 40px}
.nodo-roles-main{display:flex;flex-direction:column;gap:16px;flex:none;width:min(1080px,100%);height:fit-content;margin-inline:auto}
.nodo-roles-main[data-screen=overview]{min-width:820px}
.nodo-roles-main[data-screen=role]{width:min(800px,100%)}
.nodo-roles-nav{display:flex;flex-direction:column;gap:2px;flex:1;min-height:0}
.nodo-role-types{display:flex;align-items:center;gap:8px;flex:none;width:100%;height:36px;padding:0 12px;border:0;border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;line-height:20px;text-align:left;cursor:pointer}
.nodo-role-types:hover{background:var(--dsw-alias-interactive-bg-hover)}
.nodo-role-types[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px var(--dsw-alias-border-l2),0 0 0 .5px var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.nodo-role-types-label{flex:1;min-width:0}
.nodo-role-types-count{font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.nodo-roles-overview{--nodo-roles-columns:44px minmax(0,1.4fr) minmax(0,.8fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.3fr) 40px 64px;display:flex;flex-direction:column;gap:20px;container-type:inline-size}
.nodo-roles-head{display:flex;align-items:center;justify-content:space-between;gap:16px}
.nodo-roles-head h1{display:flex;align-items:baseline;gap:8px;margin:0;font-size:18px;font-weight:600;line-height:26px}
.nodo-roles-copy{display:flex;flex-direction:column;gap:2px;min-width:0;font-size:14px;line-height:20px}
.nodo-roles-copy>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-roles-name{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.nodo-roles-sub{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.nodo-roles-identity{justify-self:start;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}
.nodo-roles-identity[data-empty]{background:0 0;font-family:inherit}
.nodo-roles-empty{display:flex;flex-direction:column;align-items:center;gap:4px;padding:28px 24px 24px;border:1px dashed var(--dsw-alias-border-l1);border-radius:calc(var(--nodo-role-radius) + 10px);text-align:center}
.nodo-roles-empty h2{margin:0;font-size:18px;font-weight:600;line-height:26px;text-wrap:balance}
.nodo-roles-empty p{max-width:420px;margin:0 0 12px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.nodo-roles-create{display:flex;flex-wrap:wrap;align-items:center;gap:8px;width:min(600px,100%);padding:8px;border-radius:calc(var(--nodo-role-radius) + 8px);background:var(--dsw-alias-bg-layer-1);text-align:left}
.nodo-roles-create>select,.nodo-roles-create>.nodo-permission-select{flex:0 1 160px}
.nodo-roles-create>.nodo-role-identity{flex:0 1 100px;min-width:0}
.nodo-roles-new-who{display:flex;align-items:center;gap:8px;flex:1 1 220px;min-width:0}
.nodo-roles-new-who>.nodo-dialog-input{flex:1;min-width:0}
.nodo-roles-new-actions{display:flex;justify-content:flex-end;gap:8px;flex:none}
.nodo-roles-section{display:flex;flex-direction:column;gap:8px}
.nodo-roles-section h2{display:flex;align-items:center;gap:8px;margin:0;font-size:13px;font-weight:600;line-height:20px}
.nodo-roles-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.nodo-roles-table,.nodo-types-table{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:calc(var(--nodo-role-radius) + 8px)}
.nodo-roles-row,.nodo-roles-lead{display:grid;grid-template-columns:var(--nodo-roles-columns);align-items:center;gap:12px;min-height:56px;padding:6px 12px}
.nodo-roles-lead>:first-child{grid-column:1/3}
.nodo-roles-lead>:last-child{grid-column:6/-1;justify-self:end}
.nodo-roles-permission>.nodo-dialog-select{border-color:transparent;background-color:transparent;font-size:12px;text-overflow:ellipsis}
.nodo-roles-row+.nodo-roles-row,.nodo-roles-lead+.nodo-roles-lead,.nodo-type-row+.nodo-type-row{border-top:1px solid var(--dsw-alias-border-l2)}
.nodo-roles-row-head{min-height:32px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.nodo-roles-row[data-dragging]{opacity:.4}
.nodo-roles-row[data-drop]{box-shadow:inset 0 2px 0 var(--dsw-alias-state-business-primary)}
.nodo-roles-order{display:inline-flex;align-items:center;gap:8px;padding-left:4px;color:var(--dsw-alias-label-tertiary);font-size:13px;font-variant-numeric:tabular-nums}
.nodo-roles-row[draggable=true] .nodo-roles-order{cursor:grab}
.nodo-roles-who-cell{display:flex;align-items:center;gap:8px;min-width:0;margin:-4px;padding:4px;border:0;border-radius:var(--nodo-role-radius);background:0 0;color:inherit;font:inherit;text-align:left}
button.nodo-roles-who-cell{cursor:pointer}
button.nodo-roles-who-cell:hover:not(:disabled) .nodo-roles-name{text-decoration:underline}
.nodo-roles-who-cell:disabled{cursor:default}
.nodo-roles-takes{position:relative;min-width:0}
.nodo-roles-takes-trigger{max-width:calc(100% + 8px);height:28px;margin-left:-8px;padding:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;border-radius:var(--nodo-role-radius);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}
.nodo-roles-takes-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-roles-takes-trigger:disabled{cursor:default}
.nodo-roles-takes-empty{color:var(--dsw-alias-state-business-primary)}
.nodo-roles-takes-pop{position:absolute;z-index:20;top:calc(100% + 4px);right:0;display:flex;flex-direction:column;width:280px;max-height:400px;overflow-y:auto;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:calc(var(--nodo-role-radius) + 8px);background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv2)}
.nodo-roles-hard-settings{display:flex;flex-direction:column;gap:8px;margin-top:4px;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l2)}
.nodo-role-dialog .nodo-roles-hard-settings>.nodo-field{padding:0 8px 4px}
.nodo-roles-takes-option{display:flex;align-items:center;gap:8px;min-height:32px;padding:0 8px;border-radius:var(--nodo-role-radius);font-size:13px;line-height:20px;cursor:pointer}
.nodo-roles-takes-option>span{display:flex;flex-direction:column;min-width:0;padding:6px 0}
.nodo-roles-takes-option small{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.nodo-roles-takes-option:hover{background:var(--dsw-alias-interactive-bg-hover)}
.nodo-roles-takes-option input{margin:0;accent-color:var(--dsw-alias-state-business-primary)}
.nodo-roles-hard{color:var(--dsw-alias-label-secondary);font-size:13px}
.nodo-roles-actions{display:flex;justify-content:flex-end;gap:8px}
.nodo-roles-actions>.nodo-row-action{width:28px;height:28px;border-radius:var(--nodo-role-radius);color:var(--dsw-alias-label-secondary)}
.nodo-roles-actions>.nodo-row-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-roles-actions>.nodo-roles-delete:hover:not(:disabled){color:var(--dsw-alias-state-error-primary)}
.nodo-roles-new{border-radius:0 0 calc(var(--nodo-role-radius) + 7px) calc(var(--nodo-role-radius) + 7px);background:var(--dsw-alias-bg-layer-1)}
.nodo-roles-new>.nodo-roles-new-actions{grid-column:6/-1}
.nodo-roles-add{display:flex;align-items:center;gap:8px;width:fit-content;height:32px;padding:0 12px 0 6px;border:0;border-radius:var(--nodo-role-radius);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;line-height:20px;cursor:pointer}
.nodo-roles-add:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.nodo-roles-gap-note{display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border-radius:calc(var(--nodo-role-radius) + 8px);background:var(--dsw-alias-state-warn-tertiary);color:${WARN_INK};font-size:13px;line-height:22px}
.nodo-roles-gap-note>svg{flex:none;margin-top:3px}
.nodo-roles-gap-note p{margin:0}
.nodo-roles-miss{color:${WARN_INK};font-size:13px}
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
.nodo-type-takers>.nodo-avatar+.nodo-avatar{margin-left:2px}
.nodo-type-more{margin-left:6px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.nodo-type-remove{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:var(--nodo-role-radius);background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.nodo-type-remove:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary)}
.nodo-type-confirm{grid-column:1/-1;display:flex;align-items:center;gap:8px;padding:6px 6px 6px 12px;border-radius:calc(var(--nodo-role-radius) + 2px);background:var(--dsw-alias-bg-layer-1)}
.nodo-type-confirm>span{flex:1;min-width:0;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}
.nodo-types .nodo-dialog-hint{padding:16px}
.nodo-types-bar{position:sticky;bottom:24px;align-self:center;display:flex;gap:8px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:calc(var(--nodo-role-radius) + 8px);background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv2)}
@media(max-width:720px){.nodo-roles-body{padding:16px 12px 32px}}
@container (width<640px){
.nodo-roles-table{--nodo-roles-columns:44px minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.3fr) 40px 64px}
.nodo-roles-lead>:last-child{grid-column:5/-1}
.nodo-roles-row:not(.nodo-roles-new)>:nth-child(3),.nodo-roles-lead:not(.nodo-roles-new)>:nth-child(2){display:none}
.nodo-roles-new{display:flex;flex-wrap:wrap;align-items:center}
.nodo-roles-new>*{flex:1 1 140px;min-width:0}
.nodo-roles-new>.nodo-roles-order,.nodo-roles-new>.nodo-tag{flex:none}
.nodo-roles-new>.nodo-roles-new-who{flex:2 1 180px}
.nodo-roles-new>.nodo-roles-new-actions{flex:none;margin-left:auto}
}
@container (width<480px){
.nodo-roles-table{--nodo-roles-columns:44px minmax(0,1.4fr) minmax(0,1fr) minmax(0,1.3fr) 40px 64px}
.nodo-roles-lead>:last-child{grid-column:4/-1}
.nodo-roles-row:not(.nodo-roles-new)>:nth-child(4),.nodo-roles-lead:not(.nodo-roles-new)>:nth-child(3){display:none}
}
`
