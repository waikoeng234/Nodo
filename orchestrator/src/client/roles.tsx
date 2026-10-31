import type { ReactNode } from './ui-shared.js'
import {
  h, Fragment, useState, useEffect, useRef, useSyncExternalStore, useStateView, call,
  Modal, Button, roleStateOf, layoutService, IconChecklistOutlineRegular, IconPlusOutlineRegular, IconUsersOutlineRegular, WARN_INK,
} from './ui-shared.js'
import { RoleEditor } from './profile-dialogs.js'
import { TeamsSection, AssignPage, TEAMS_CSS } from './teams.tsx'
import type { Team } from './teams.tsx'
import type { ModelChoice } from './model-options.js'

interface RoleCard {
  id: string; name: string; identity?: string; instructions?: string; deletedAt?: number; engine?: string; role?: string; model?: string; thinking?: string; lead?: boolean
  avatarTemplate?: string; permission?: string; sessions?: { id: string; draftedAt?: number; briefSent?: boolean }[]
}
interface EngineChoice { id: string; label?: string; capabilities?: { permissionModes?: string[] }; catalog?: { models?: ModelChoice[]; defaultModel?: string } }
interface RolePreset { name: string; role: string; instructions: string }
interface RolesView {
  profiles: RoleCard[]
  work?: Record<string, { active?: boolean } | undefined>
  teams?: Team[]
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
let rolesTarget: { profileId?: string; team?: string } | null = null
const targetListeners = new Set<() => void>()
export const readRolesTarget = () => rolesTarget
export const subscribeRolesTarget = (listener: () => void) => { targetListeners.add(listener); return () => { targetListeners.delete(listener) } }
export const openRoles = (target: { profileId?: string; team?: string } = {}) => {
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


export function RolesPage({ view, readOnly, refresh }: { view: RolesView; readOnly: boolean; refresh: (force?: boolean) => Promise<void> }) {
  const target = useSyncExternalStore(subscribeRolesTarget, readRolesTarget)
  const [roleId, setRoleId] = useState<string | null>(() => target?.profileId && target.profileId !== 'new' ? target.profileId : null)
  const [assignOpen, setAssignOpen] = useState(false)
  const [teamId, setTeamId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ action: () => void } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [nonce, setNonce] = useState(0)
  const [adding, setAdding] = useState(() => target?.profileId === 'new')
  const [engines, setEngines] = useState<EngineChoice[] | null>(null)
  const dirtyRef = useRef(false)
  const roles = view.profiles.filter(role => !role.deletedAt)
  const teams = view.teams ?? []
  // The count in the nav mirrors the team the assignment page would open.
  const types = (teams.find(item => item.id === teamId) ?? teams[0])?.types ?? []
  const executors = roles.filter(item => item.lead !== true)
  const creating = adding || !executors.length
  const perform = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await action(); await refresh(true) } catch (failure) { setError((failure as Error).message) }
    finally { setBusy(false) }
  }
  const run = (action: () => void) => { setAdding(false); setError(''); action() }
  const switchTo = (action: () => void) => { if (dirtyRef.current) setConfirm({ action: () => run(action) }); else run(action) }
  const showOverview = () => { setAssignOpen(false); setRoleId(null) }
  const openRole = (id: string) => { setAssignOpen(false); setRoleId(id) }
  const startAdding = () => { showOverview(); setAdding(true) }
  useEffect(() => {
    leaveGuard = switchTo
    return () => { leaveGuard = null }
  }, [])
  useEffect(() => {
    if (!target) return
    consumeRolesTarget()
    switchTo(() => {
      if (!target.team) return target.profileId && target.profileId !== 'new' ? openRole(target.profileId) : startAdding()
      showOverview()
      if (target.team !== 'new') return setTeamId(target.team!)
      const id = crypto.randomUUID()
      saveTeams([...teams, { id, name: '', lead: null, members: [], types: [], assign: {} }])
      setTeamId(id)
    })
  }, [target])
  // The assignment pickers read the engine catalog.
  useEffect(() => {
    if (engines !== null) return
    setEngines([])
    void call('engine-catalog').then((items: EngineChoice[]) => {
      setEngines(items)
    }).catch(failure => setError((failure as Error).message))
  }, [engines])

  const savedRole = async (saved: { id: string }) => { await refresh(true); setAdding(false); setRoleId(saved.id) }
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
  // A role leads exactly when it sits in some team's lead column; demotions go
  // first so a swap never leaves the roster without an executor.
  const saveTeams = (next: Team[]) => void perform(async () => {
    const leads = new Set(next.map(team => team.lead))
    const changed = roles.filter(role => (role.lead === true) !== leads.has(role.id)).sort((a, b) => Number(a.lead !== true) - Number(b.lead !== true))
    for (const role of changed) await call('profile-update', { id: role.id, changes: { lead: role.lead !== true } })
    await call('teams-update', { teams: next })
  })
  const deleteReason = (role: RoleCard) => roles.some(item => item.lead === true) && role.lead !== true && executors.length === 1 ? '主控至少需要一个执行角色' : undefined

  const locked = readOnly || busy
  const overview = (
    <div className="nodo-roles-overview">
      <header className="nodo-roles-head"><h1>角色与团队</h1></header>
      <TeamsSection roles={roles} teams={teams} activeId={teamId} locked={locked} onActive={setTeamId} save={saveTeams}
        openRole={id => switchTo(() => openRole(id))} onAssign={() => switchTo(() => setAssignOpen(true))}
        createButton={<button type="button" className="nodo-roles-add" disabled={locked} onClick={() => switchTo(startAdding)}><IconPlusOutlineRegular size={14} />创建角色</button>} />
    </div>
  )

  const sidebar = (
    <div className="nodo-roles-nav" role="navigation" aria-label="角色">
      <button type="button" className="nodo-role-types" aria-pressed={!assignOpen} onClick={() => switchTo(showOverview)}>
        <IconUsersOutlineRegular size={16} /><span className="nodo-role-types-label">全部角色</span><span className="nodo-role-types-count">{roles.length}</span>
      </button>
      <button type="button" className="nodo-role-types" aria-pressed={assignOpen} onClick={() => switchTo(() => setAssignOpen(true))}>
        <IconChecklistOutlineRegular size={16} /><span className="nodo-role-types-label">任务分配</span><span className="nodo-role-types-count">{types.length}</span>
      </button>
    </div>
  )
  useEffect(() => { rolesPublishSidebar({ view: 'roles', content: sidebar }) })
  const selected = roleId !== null ? roles.find(item => item.id === roleId) ?? null : null
  return (
    <section className="nodo-page nodo-roles" aria-label="角色管理">
      <div className="nodo-roles-chrome" aria-hidden />
      <div className="nodo-roles-body">
        <div className="nodo-role-dialog nodo-roles-main" data-screen={assignOpen ? 'assign' : selected || creating ? 'role' : 'overview'}>
          {assignOpen
            ? <AssignPage roles={roles} teams={teams} engines={engines ?? []} activeId={teamId} disabled={locked}
              onActive={setTeamId} onBack={() => switchTo(showOverview)} save={saveTeams} />
            : selected
              ? (
                <RoleEditor key={`${selected.id}:${nonce}`} profile={selected}
                  deleteReason={deleteReason(selected)}
                  enabledEngines={view.prefs?.enabledEngines ?? null} savedIdentities={view.prefs?.rolePresets ?? null}
                  refresh={refresh} readOnly={readOnly}
                  onSaved={savedRole} onCancel={() => { setNonce(value => value + 1); showOverview() }} onBack={() => switchTo(showOverview)} onDeleted={deletedRole}
                  onDirtyChange={value => { dirtyRef.current = value }} />
              )
              : creating
                ? (
                  <RoleEditor key={`new:${nonce}`} profile={null} avatarSeed={roles.length}
                    enabledEngines={view.prefs?.enabledEngines ?? null} savedIdentities={view.prefs?.rolePresets ?? null}
                    refresh={refresh} readOnly={readOnly}
                    onSaved={savedRole} onCancel={() => { setNonce(value => value + 1); setAdding(false) }} onBack={executors.length ? () => switchTo(showOverview) : null}
                    onDeleted={deletedRole} onDirtyChange={value => { dirtyRef.current = value }} />
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
.nodo-roles-chrome{flex:none;height:var(--nodo-top-clearance,0px);-webkit-app-region:drag}
.nodo-roles-body{display:flex;flex:1;min-width:0;min-height:0;overflow:auto;padding:20px 32px 40px}
.nodo-roles-main{display:flex;flex-direction:column;gap:16px;flex:none;width:min(1080px,100%);height:fit-content;margin-inline:auto}
.nodo-roles-main[data-screen=overview]{min-width:820px}
.nodo-roles-main[data-screen=role]{width:min(800px,100%)}
.nodo-roles-main[data-screen=assign]{width:min(980px,100%)}
.nodo-roles-nav{display:flex;flex-direction:column;gap:2px;flex:1;min-height:0}
.nodo-role-types{display:flex;align-items:center;gap:8px;flex:none;width:100%;height:36px;padding:0 12px;border:0;border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;line-height:20px;text-align:left;cursor:pointer}
.nodo-role-types:hover{background:var(--dsw-alias-interactive-bg-hover)}
.nodo-role-types[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px var(--dsw-alias-border-l2),0 0 0 .5px var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.nodo-role-types-label{flex:1;min-width:0}
.nodo-role-types-count{font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.nodo-roles-overview{display:flex;flex-direction:column;gap:20px}
.nodo-roles-head{display:flex;align-items:center;justify-content:space-between;gap:16px}
.nodo-roles-head h1{display:flex;align-items:baseline;gap:8px;margin:0;font-size:18px;font-weight:600;line-height:26px}
.nodo-roles-copy{display:flex;flex-direction:column;gap:2px;min-width:0;font-size:14px;line-height:20px}
.nodo-roles-copy>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nodo-roles-name{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.nodo-roles-sub{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.nodo-roles-section{display:flex;flex-direction:column;gap:8px}
.nodo-roles-section h2{display:flex;align-items:center;gap:8px;margin:0;font-size:13px;font-weight:600;line-height:20px}
.nodo-roles-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.nodo-roles-add{display:flex;align-items:center;gap:8px;width:fit-content;height:32px;padding:0 12px 0 6px;border:0;border-radius:var(--nodo-role-radius);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;line-height:20px;cursor:pointer}
.nodo-roles-add:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.nodo-text-button{height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:13px;cursor:pointer}
.nodo-text-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-text-button:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.nodo-types-count{color:var(--dsw-alias-label-tertiary);font-size:13px;font-weight:400;font-variant-numeric:tabular-nums}
.nodo-type-input{width:100%;height:32px;padding:0 8px;border:1px solid transparent;border-radius:var(--nodo-role-radius);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:20px}
.nodo-type-input::placeholder{color:var(--dsw-alias-label-tertiary);opacity:1}
.nodo-type-input:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-type-input:focus{outline:0;border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-base)}
@media(max-width:720px){.nodo-roles-body{padding:16px 12px 32px}}
${TEAMS_CSS}`
