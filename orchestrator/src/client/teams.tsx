import { h, Fragment, useState, useEffect, WARN_INK, Modal, Button, IconChevronRightOutlineRegular, IconPlusOutlineRegular, IconTrashOutlineRegular } from './ui-shared.js'
import { RoleAvatar, avatarTemplateOf } from './avatar.tsx'
import { EngineMark, engineDisplayName } from './engine-logos.js'
import { route } from '../../core/shared/route.js'
import type { ReactNode } from './ui-shared.js'
import { modelName, modelLabel } from './model-options.js'
import type { ModelChoice } from './model-options.js'

const fitText = (el: HTMLTextAreaElement | null) => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }

export interface TeamPick { profile?: string; model?: string; thinking?: string }
export interface Team { id: string; name: string; lead: string | null; members: string[]; types: TeamType[]; assign: Record<string, { normal?: TeamPick; hard?: TeamPick }> }
export interface TeamRole { id: string; name: string; engine?: string; model?: string }
export interface TeamType { id?: string; name: string; when?: string }
export interface TeamEngine { id: string; catalog?: { models?: ModelChoice[]; defaultModel?: string } }

type DropEvent = { preventDefault: () => void; stopPropagation?: () => void }
// Confirmations for drops that would break the one-role-one-place rules: a lead
// taking the target team must leave every membership, and a lead joining a team
// must give up leading. `leading` only explains why the drop is refused.
type Pending = { kind: 'lead'; id: string; teamId: string; from: string[] }
  | { kind: 'leading'; id: string; teamId: string }
  | { kind: 'member'; id: string; teamId: string; from: string }

const TEAM_NAME_MAX = 20
const TYPES_MAX = 20
const CARD = 76
const GAP = 8

const withoutRole = (team: Team, id: string): Team => ({
  ...team,
  lead: team.lead === id ? null : team.lead,
  members: team.members.filter(member => member !== id),
  assign: Object.fromEntries(Object.entries(team.assign).map(([type, entry]) => [type, Object.fromEntries(Object.entries(entry).map(([key, pick]) =>
    [key, pick.profile === id ? { ...pick, profile: undefined } : pick]))])),
})

const roleModel = (role: TeamRole) => modelName(role.model) || '默认模型'
const tint = (role: TeamRole) => {
  const color = avatarTemplateOf(role).color
  return { background: `color-mix(in srgb,${color} 18%,var(--dsw-alias-bg-base))`, color: `color-mix(in srgb,${color} 35%,var(--dsw-alias-label-primary))` }
}

// The roles grid and the active team's tree. Cards drag between the grid, a
// team's lead column, its panel or tab; every change saves the whole team list.
export function TeamsSection({ roles, teams, activeId, locked, onActive, save, openRole, onAssign, createButton }: {
  roles: TeamRole[]; teams: Team[]; activeId: string | null; locked: boolean
  onActive: (id: string) => void; save: (next: Team[]) => void; openRole: (id: string) => void
  onAssign: () => void; createButton: ReactNode
}) {
  const [drag, setDrag] = useState<{ id: string; from: string } | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const byId = (id: string) => roles.find(role => role.id === id)
  const current = teams.find(team => team.id === activeId) ?? teams[0]
  const edit = (id: string, change: (team: Team) => Team) => save(teams.map(team => team.id === id ? change(team) : team))
  const target = (zone: string) => ({
    onDragOver: (event: DropEvent) => { if (drag && !locked) { event.preventDefault(); event.stopPropagation?.(); setOver(zone) } },
    onDragLeave: () => setOver(value => value === zone ? null : value),
  })
  // The two saves a drop can commit. Leading the target team takes the role out
  // of every membership (a lead sits in no members list); joining keeps every
  // team but strips the role from the column of the team it led.
  const setLead = (teamId: string, roleId: string) => {
    save(teams.map(team => team.id === teamId ? { ...withoutRole(team, roleId), lead: roleId } : withoutRole(team, roleId)))
    onActive(teamId)
  }
  const joinMember = (teamId: string, roleId: string) => {
    save(teams.map(team => {
      if (team.id !== teamId) return team.lead === roleId ? { ...team, lead: null } : team
      return { ...team, lead: team.lead === roleId ? null : team.lead,
        members: team.members.includes(roleId) ? team.members : [...team.members, roleId] }
    }))
    onActive(teamId)
  }
  const drop = (zone: string) => (event: DropEvent) => {
    event.preventDefault(); event.stopPropagation?.()
    const moved = drag && byId(drag.id)
    setDrag(null); setOver(null)
    // Cards join another team and keep their other memberships; the × removes a
    // role from a team, and the grid no longer means removal. A lead stays lead
    // of one team only, so dropping it anywhere else clears that column.
    if (!moved || !drag || zone === drag.from || zone === 'lib') return
    const leadOf = zone.startsWith('lead:') ? zone.slice(5) : null
    const id = leadOf ?? zone
    if (leadOf) {
      const leading = teams.find(team => team.lead === moved.id && team.id !== id)
      if (leading) return setPending({ kind: 'leading', id: moved.id, teamId: leading.id })
      const memberships = teams.filter(team => team.id !== id && team.members.includes(moved.id))
      if (memberships.length) return setPending({ kind: 'lead', id: moved.id, teamId: id, from: memberships.map(team => team.id) })
      return setLead(id, moved.id)
    }
    const leading = teams.find(team => team.lead === moved.id)
    if (leading) return setPending({ kind: 'member', id: moved.id, teamId: id, from: leading.id })
    joinMember(id, moved.id)
  }
  const teamLabel = (teamId: string) => {
    const team = teams.find(item => item.id === teamId)
    return team ? team.name || `团队 ${teams.indexOf(team) + 1}` : ''
  }
  const dialog = pending && (() => {
    const name = byId(pending.id)?.name ?? ''
    if (pending.kind === 'leading') return {
      title: `「${name}」已是「${teamLabel(pending.teamId)}」的主控`,
      body: '一个主控只能领导一个团队。如需在多个团队使用同一套设定，请复制该角色。',
      footer: [<Button key="ok" variant="outline" onClick={() => setPending(null)}>知道了</Button>],
    }
    if (pending.kind === 'lead') return {
      title: `将「${name}」设为「${teamLabel(pending.teamId)}」的主控？`,
      body: `主控不能同时是其它团队的成员。继续会把「${name}」从${pending.from.map(teamId => `「${teamLabel(teamId)}」`).join('')}的成员中移除。`,
      footer: [
        <Button key="cancel" variant="outline" onClick={() => setPending(null)}>取消</Button>,
        <Button key="ok" variant="primary" onClick={() => { const next = pending; setPending(null); setLead(next.teamId, next.id) }}>移除并设为主控</Button>,
      ],
    }
    return {
      title: `将「${name}」加入「${teamLabel(pending.teamId)}」的成员？`,
      body: `「${name}」目前是「${teamLabel(pending.from)}」的主控，不能同时是成员。继续会取消它的主控身份，「${teamLabel(pending.from)}」将没有主控。`,
      footer: [
        <Button key="cancel" variant="outline" onClick={() => setPending(null)}>取消</Button>,
        <Button key="ok" variant="primary" onClick={() => { const next = pending; setPending(null); joinMember(next.teamId, next.id) }}>取消主控并加入</Button>,
      ],
    }
  })()
  const card = (role: TeamRole, from: string, team?: Team) => (
    <div key={role.id} className="nodo-team-card" draggable={!locked} data-dragging={drag?.id === role.id ? '' : undefined}
      onDragStart={(event: { dataTransfer: DataTransfer }) => { setDrag({ id: role.id, from }); event.dataTransfer.effectAllowed = 'move' }}
      onDragEnd={() => { setDrag(null); setOver(null) }}>
      <button type="button" className="nodo-team-card-main" title={role.name} onClick={() => openRole(role.id)}>
        <RoleAvatar profile={role} size={44} />
        <span className="nodo-roles-copy">
          <span className="nodo-roles-name">{role.name}</span>
          <span className="nodo-team-meta">
            <span title={engineDisplayName({ id: role.engine ?? '' })}><EngineMark engine={role.engine} size={16} /></span>
            <span className="nodo-team-model" style={tint(role)}>{roleModel(role)}</span>
          </span>
        </span>
      </button>
      {team
        ? <button type="button" className="nodo-team-card-act" aria-label={`把 ${role.name} 移出团队`} title="从团队移除" disabled={locked}
          onClick={() => edit(team.id, item => withoutRole(item, role.id))}>×</button>
        : (() => {
          const count = teams.filter(item => item.lead === role.id || item.members.includes(role.id)).length
          return count > 0 && <span className="nodo-team-count" title={`在 ${count} 个团队中`}>{count}</span>
        })()}
    </div>
  )
  const slot = (label: string) => <div className="nodo-team-slot"><IconPlusOutlineRegular size={14} />{label}</div>
  const lead = current?.lead ? byId(current.lead) : undefined
  const members = current?.members.map(byId).filter((role): role is TeamRole => role !== undefined) ?? []
  const rows = [...members, undefined]
  const height = rows.length * CARD + (rows.length - 1) * GAP
  return (
    <Fragment>
      <section className="nodo-roles-section" aria-labelledby="nodo-roles-all">
        <div className="nodo-roles-section-head">
          <h2 id="nodo-roles-all">全部角色<span className="nodo-types-count">{roles.length}</span></h2>
          {createButton}
        </div>
        <div className="nodo-team-grid" data-over={over === 'lib' ? '' : undefined} {...target('lib')} onDrop={drop('lib')}>
          {roles.map(role => card(role, 'lib'))}
        </div>
      </section>
      <section className="nodo-roles-section" aria-labelledby="nodo-roles-teams">
        <div className="nodo-roles-section-head">
          <div className="nodo-team-tabs" role="tablist" aria-label="团队">
            <h2 id="nodo-roles-teams">团队</h2>
            {teams.map((team, index) => (
              <button key={team.id} type="button" role="tab" className="nodo-team-tab" aria-selected={team === current} data-over={over === `tab:${team.id}` ? '' : undefined}
                onClick={() => onActive(team.id)} {...target(`tab:${team.id}`)} onDrop={drop(team.id)}>
                <span className="nodo-team-no">{index + 1}</span>{team.name || '未命名团队'}
              </button>
            ))}
            <button type="button" className="nodo-team-card-act" aria-label="新增团队" title="新增团队" disabled={locked}
              onClick={() => { const id = crypto.randomUUID(); save([...teams, { id, name: '', lead: null, members: [], types: [], assign: {} }]); onActive(id) }}><IconPlusOutlineRegular size={14} /></button>
          </div>
          <button type="button" className="nodo-roles-add" onClick={onAssign}>任务分配</button>
        </div>
        {current && (
          <div className="nodo-team-panel" data-over={over === current.id ? '' : undefined} aria-label={`团队 ${teams.indexOf(current) + 1}`} {...target(current.id)} onDrop={drop(current.id)}>
            <div className="nodo-team-head">
              <input className="nodo-team-name" key={current.id} defaultValue={current.name} maxLength={TEAM_NAME_MAX} placeholder="未命名团队" aria-label="团队名称" disabled={locked}
                onBlur={(event: { target: { value: string } }) => { if (event.target.value !== current.name) edit(current.id, item => ({ ...item, name: event.target.value })) }} />
              <span className="nodo-roles-sub">{`${members.length + (lead ? 1 : 0)} 人`}</span>
              <button type="button" className="nodo-team-card-act nodo-team-del" aria-label="删除团队" title="删除团队" disabled={locked}
                onClick={() => save(teams.filter(team => team !== current))}><IconTrashOutlineRegular size={14} /></button>
            </div>
            <div className="nodo-team-tree">
              <div className="nodo-team-col" data-over={over === `lead:${current.id}` ? '' : undefined} {...target(`lead:${current.id}`)} onDrop={drop(`lead:${current.id}`)}>
                {lead ? card(lead, `lead:${current.id}`, current) : slot('拖入主控')}
              </div>
              <svg className="nodo-team-lines" width="72" height={height} viewBox={`0 0 72 ${height}`} fill="none" aria-hidden="true">
                {rows.map((_, index) => {
                  const y = index * (CARD + GAP) + CARD / 2
                  return <path key={index} d={`M0 ${height / 2} C36 ${height / 2} 36 ${y} 72 ${y}`} stroke="var(--dsw-alias-state-business-primary)" strokeWidth="1.5" opacity=".75"
                    strokeDasharray={!lead || index === rows.length - 1 ? '4 4' : undefined} />
                })}
              </svg>
              <div className="nodo-team-col">
                {members.map(role => card(role, current.id, current))}
                {slot('拖入角色')}
              </div>
            </div>
          </div>
        )}
      </section>
      {pending && dialog && <Modal open title={dialog.title} onClose={() => setPending(null)} closeLabel="关闭" className="nodo-dialog" footer={dialog.footer}>
        <p>{dialog.body}</p>
      </Modal>}
    </Fragment>
  )
}

// One picker per cell: role first, then the model and thinking it runs with.
export function PickCell({ label, pick, team, roles, engines, optional, disabled, onChange, remove }: {
  label: string; pick: TeamPick | undefined; team: Team; roles: TeamRole[]; engines: TeamEngine[]; optional: boolean
  disabled: boolean; onChange: (pick: TeamPick | undefined) => void; remove?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = (event: Event) => { if (!(event.target as Element | null)?.closest?.('[data-pick-open]')) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const holder = roles.find(role => role.id === pick?.profile)
  const catalog = engines.find(engine => engine.id === holder?.engine)?.catalog
  const models = catalog?.models ?? []
  const model = models.find(item => item.id === (pick?.model || holder?.model || catalog?.defaultModel))
  const levels = model?.thinking ?? []
  const providers = new Map<string, ModelChoice[]>()
  for (const item of models) providers.set(item.group ?? '', [...(providers.get(item.group ?? '') ?? []), item])
  const set = (changes: TeamPick) => onChange({ ...pick, ...changes })
  const tags = [pick?.model ? modelLabel(models.find(item => item.id === pick.model) ?? { id: pick.model }) : '', pick?.thinking ? levels.find(level => level.id === pick.thinking)?.label ?? pick.thinking : ''].filter(Boolean)
  return (
    <div className="nodo-pick" data-warn={holder ? undefined : ''} data-removable={remove ? '' : undefined} data-pick-open={open ? '' : undefined}>
      <button type="button" className="nodo-pick-trigger" aria-haspopup="dialog" aria-expanded={open} aria-label={`${label} ${holder?.name ?? '无人承接'}`} disabled={disabled}
        onClick={() => setOpen(!open)}>
        {holder ? <RoleAvatar profile={holder} size={24} /> : <span className="nodo-pick-none" />}
        <span className="nodo-pick-name">{holder?.name ?? '无人承接'}</span>
        {holder && tags.map((tag, index) => <span key={index} className="nodo-team-model" style={tint(holder)}>{tag}</span>)}
        <IconChevronRightOutlineRegular size={12} />
      </button>
      {remove}
      {open && (
        <div className="nodo-pick-pop" role="dialog" aria-label={`${label} 的角色`}
          onKeyDown={(event: { key: string }) => { if (event.key === 'Escape') setOpen(false) }}>
          <span className="nodo-pick-label">角色</span>
          <div className="nodo-pick-group">
            {optional && <button type="button" className="nodo-pick-option" aria-pressed={!holder} onClick={() => onChange(undefined)}>不单独指定</button>}
            {team.members.map(id => roles.find(role => role.id === id)).filter((role): role is TeamRole => role !== undefined).map(role => (
              <button key={role.id} type="button" className="nodo-pick-option" aria-pressed={role.id === holder?.id}
                onClick={() => onChange({ profile: role.id })}><RoleAvatar profile={role} size={20} />{role.name}</button>
            ))}
          </div>
          {holder && models.length > 0 && <span className="nodo-pick-label">模型</span>}
          {holder && models.length > 0 && <div className="nodo-pick-models" role="group" aria-label="模型">
            {[...providers].map(([group, items]) => (
              <Fragment key={group}>
                {group && <span className="nodo-pick-provider">{group}</span>}
                <div className="nodo-pick-group">
                  {items.map(item => <button key={item.id} type="button" className="nodo-pick-option" aria-pressed={item.id === model?.id}
                    onClick={() => set({ model: item.id, thinking: item.thinking?.some(level => level.id === pick?.thinking) ? pick?.thinking : undefined })}>{modelLabel(item)}</button>)}
                </div>
              </Fragment>
            ))}
          </div>}
          {holder && levels.length > 0 && <span className="nodo-pick-label">思考强度</span>}
          {holder && levels.length > 0 && <div className="nodo-pick-group" role="group" aria-label="思考强度">
            {levels.map(level => <button key={level.id} type="button" className="nodo-pick-option" aria-pressed={level.id === (pick?.thinking || model?.defaultThinking)}
              onClick={() => set({ thinking: level.id })}>{level.label ?? level.id}</button>)}
          </div>}
        </div>
      )}
    </div>
  )
}

export function AssignPage({ roles, teams, engines, activeId, disabled, onActive, onBack, save }: {
  roles: TeamRole[]; teams: Team[]; engines: TeamEngine[]; activeId: string | null; disabled: boolean
  onActive: (id: string) => void; onBack: () => void; save: (next: Team[]) => void
}) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [when, setWhen] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  const team = teams.find(item => item.id === activeId) ?? teams[0]
  const types = team?.types ?? []
  const edit = (typeId: string, key: 'normal' | 'hard', pick: TeamPick | undefined) => save(teams.map(item => {
    if (item !== team) return item
    const entry = { ...item.assign[typeId] }
    if (pick) entry[key] = pick; else delete entry[key]
    return { ...item, assign: { ...item.assign, [typeId]: entry } }
  }))
  const gaps = team ? types.reduce((sum, { id = '' }) => sum + ('miss' in route(team.assign, id, false) ? 1 : 0) + (team.assign[id]?.hard && 'miss' in route(team.assign, id, true) ? 1 : 0), 0) : 0
  const draftOk = name.trim() !== '' && !types.some(type => type.name === name.trim())
  const leadRole = roles.find(role => role.id === team?.lead)
  const patchTypes = (next: TeamType[]) => save(teams.map(item => item === team ? { ...item, types: next } : item))
  const patchType = (index: number, changes: Partial<TeamType>) => patchTypes(types.map((type, i) => i === index ? { ...type, ...changes } : type))
  // A removed type takes its assignments with it, or the whole-table save would
  // still reference it.
  const removeType = (type: TeamType) => save(teams.map(item => item === team ? { ...item,
    types: item.types.filter(item2 => item2 !== type),
    assign: Object.fromEntries(Object.entries(item.assign).filter(([id]) => id !== (type.id ?? ''))) } : item))
  const reset = () => { setAdding(false); setName(''); setWhen('') }
  return (
    <section className="nodo-assign" aria-label="任务分配">
      <button type="button" className="nodo-assign-back" onClick={onBack}><IconChevronRightOutlineRegular size={14} />全部角色</button>
      <div className="nodo-roles-section-head">
        <div className="nodo-team-tabs" role="tablist" aria-label="团队">
          <h2>任务分配</h2>
          {teams.map((item, index) => (
            <button key={item.id} type="button" role="tab" className="nodo-team-tab" aria-selected={item === team} onClick={() => onActive(item.id)}>
              <span className="nodo-team-no">{index + 1}</span>{item.name || '未命名团队'}
            </button>
          ))}
        </div>
        {team && <div className="nodo-assign-meta">
          {gaps > 0 && <span className="nodo-assign-gap" role="status">{`${gaps} 处无人承接`}</span>}
          {leadRole && <span className="nodo-assign-lead"><RoleAvatar profile={leadRole} size={22} />{leadRole.name}<span className="nodo-tag">主控</span></span>}
        </div>}
      </div>
      {!team ? <p className="nodo-dialog-hint">先在角色页建立团队</p> : (
        <div className="nodo-assign-panel">
          <div className="nodo-assign-row nodo-assign-head"><span /><span>负责角色</span><span>困难任务另派（可选）</span></div>
          {types.map((type, index) => {
            const entry = team.assign[type.id ?? ''] ?? {}
            return (
              <div key={type.id} className="nodo-assign-row" role="group" aria-label={type.name}>
                <div className="nodo-assign-type">
                  <span className="nodo-assign-type-top">
                    <input className="nodo-type-input" key={`${type.id}:${type.name}`} defaultValue={type.name} maxLength={20} aria-label={`任务类型名称 ${type.name}`} disabled={disabled}
                      onBlur={(event: { target: { value: string } }) => { const value = event.target.value.trim(); if (value && value !== type.name) patchType(index, { name: value }) }} />
                  </span>
                  <textarea rows={1} ref={fitText} onInput={(event: { currentTarget: HTMLTextAreaElement }) => fitText(event.currentTarget)} className="nodo-type-input nodo-type-sub" key={`${type.id}:${type.when}`} defaultValue={type.when ?? ''} maxLength={200} placeholder="什么时候派这类任务" aria-label={`任务类型说明 ${type.name}`} disabled={disabled}
                    onKeyDown={(event: { key: string; preventDefault: () => void; currentTarget: { blur: () => void } }) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }}
                    onBlur={(event: { target: { value: string } }) => { if (event.target.value !== (type.when ?? '')) patchType(index, { when: event.target.value }) }} />
                </div>
                <PickCell label={`${type.name}${entry.hard ? ' · 普通任务' : ' · 普通和困难任务'}`} pick={entry.normal} team={team} roles={roles} engines={engines}
                  optional={false} disabled={disabled} onChange={pick => edit(type.id ?? '', 'normal', pick ?? {})}
                  remove={removing === type.id
                    ? <button type="button" className="nodo-assign-confirm" disabled={disabled} onClick={() => { setRemoving(null); removeType(type) }}>删除</button>
                    : <button type="button" className="nodo-assign-remove" aria-label={`删除 ${type.name}`} disabled={disabled} onClick={() => setRemoving(type.id ?? null)}>×</button>} />
                {entry.hard
                  ? <PickCell label={`${type.name} · 困难任务`} pick={entry.hard} team={team} roles={roles} engines={engines} optional disabled={disabled} onChange={pick => edit(type.id ?? '', 'hard', pick ?? undefined)}
                    remove={<button type="button" className="nodo-assign-remove" aria-label={`${type.name} 不再单独指定困难任务`} disabled={disabled} onClick={() => edit(type.id ?? '', 'hard', undefined)}>×</button>} />
                  : <button type="button" className="nodo-assign-split" disabled={disabled} onClick={() => edit(type.id ?? '', 'hard', {})}>
                    <IconPlusOutlineRegular size={14} />困难任务单独指定</button>}
              </div>
            )
          })}
          <div className="nodo-assign-foot">
            {adding
              ? <form className="nodo-assign-add" onSubmit={(event: { preventDefault: () => void }) => { event.preventDefault(); if (draftOk) { patchTypes([...types, { name: name.trim(), when: when.trim() }]); reset() } }}
                onKeyDown={(event: { key: string }) => { if (event.key === 'Escape') reset() }}>
                <input className="nodo-assign-field nodo-assign-field-name" autoFocus placeholder="类型名称" aria-label="类型名称" maxLength={20} value={name} onChange={(event: { target: { value: string } }) => setName(event.target.value)} />
                <span className="nodo-assign-field">
                  <input placeholder="什么时候派这类任务" aria-label="类型说明" maxLength={200} value={when} onChange={(event: { target: { value: string } }) => setWhen(event.target.value)} />
                  <button type="button" className="nodo-text-button" onClick={reset}>取消</button>
                  <button type="submit" className="nodo-text-button" disabled={disabled || !draftOk}>添加</button>
                </span>
              </form>
              : <button type="button" className="nodo-roles-add" disabled={disabled || types.length >= TYPES_MAX} onClick={() => setAdding(true)}><IconPlusOutlineRegular size={14} />添加任务类型</button>}
          </div>
        </div>
      )}
    </section>
  )
}

export const TEAMS_CSS = `
.nodo-team-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:4px;margin:-8px;padding:8px}
.nodo-team-grid[data-over],.nodo-team-panel[data-over],.nodo-team-col[data-over]{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary)}
.nodo-team-col[data-over]{border-radius:10px}
.nodo-team-card{position:relative;display:flex;align-items:center;gap:8px;box-sizing:border-box;height:76px;min-width:0;padding:0 12px 0 16px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base));box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1);cursor:grab}
.nodo-team-card:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,var(--dsw-alias-bg-base))}
.nodo-team-card[data-dragging]{opacity:.4}
.nodo-team-card-main{display:flex;align-items:center;gap:14px;flex:1;min-width:0;padding:0;border:0;background:0 0;color:inherit;font:inherit;text-align:left;cursor:inherit}
.nodo-team-card-main:hover .nodo-roles-name>:first-child{text-decoration:underline}
.nodo-team-card .nodo-avatar{border-radius:14px}
.nodo-team-meta{display:flex;align-items:center;gap:8px;min-width:0;height:22px}
.nodo-team-meta>span:first-child{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
.nodo-team-model{min-width:0;height:22px;padding:0 9px;overflow:hidden;border-radius:999px;font-size:12px;line-height:22px;text-overflow:ellipsis;white-space:nowrap}
.nodo-team-card-act{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:var(--nodo-role-radius,8px);background:0 0;color:var(--dsw-alias-label-tertiary);font-size:16px;cursor:pointer}
.nodo-team-card-act:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.nodo-team-del:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.nodo-team-count{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;border-radius:50%;background:var(--dsw-alias-interactive-bg-hover);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}
.nodo-team-slot{display:flex;align-items:center;justify-content:center;gap:10px;box-sizing:border-box;height:76px;border:1px dashed var(--dsw-alias-border-l1);border-radius:10px;color:var(--dsw-alias-label-tertiary);font-size:13px}
.nodo-team-tabs{display:flex;align-items:center;flex-wrap:wrap;gap:4px;min-width:0}
.nodo-team-tabs h2{margin:0 8px 0 0}
.nodo-team-tab{display:inline-flex;align-items:center;gap:8px;max-width:200px;height:32px;padding:0 12px 0 6px;border:0;border-radius:10px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;cursor:pointer}
.nodo-team-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}
.nodo-team-tab[aria-selected=true]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);color:var(--dsw-alias-label-primary)}
.nodo-team-tab[data-over]{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary)}
.nodo-team-no{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;border-radius:50%;background:var(--dsw-alias-interactive-bg-hover);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}
.nodo-team-tab[aria-selected=true] .nodo-team-no{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}
.nodo-team-panel{display:flex;flex-direction:column;gap:4px;padding:8px 0}
.nodo-team-head{display:flex;align-items:center;gap:8px;height:40px;padding:0 4px 0 8px}
.nodo-team-name{field-sizing:content;flex:0 1 auto;min-width:96px;max-width:320px;height:28px;padding:0 8px;border:0;border-radius:8px;background:0 0;color:inherit;font:inherit;font-size:14px;font-weight:600}
.nodo-team-name:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-team-tree{display:flex;align-items:center;justify-content:center}
.nodo-team-col{display:flex;flex-direction:column;gap:8px;width:300px;max-width:100%;flex:none}
.nodo-team-lines{flex:none}
.nodo-assign{display:flex;flex-direction:column;gap:12px}
.nodo-assign-back{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;height:36px;padding:0 12px 0 8px;border:0;border-radius:10px;background:0 0;color:inherit;font:inherit;font-size:14px;font-weight:500;cursor:pointer}
.nodo-assign-back:hover{background:var(--dsw-alias-interactive-bg-hover)}
.nodo-assign-back>svg{transform:rotate(180deg)}
.nodo-assign-meta{display:flex;align-items:center;gap:8px}
.nodo-assign-gap{display:inline-flex;align-items:center;height:28px;padding:0 10px;border-radius:8px;background:var(--dsw-alias-state-warn-tertiary);color:${WARN_INK};font-size:12px;font-weight:500}
.nodo-assign-lead{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:500}
.nodo-assign-row{display:grid;grid-template-columns:168px 1fr 1fr;align-items:center;column-gap:12px;min-height:60px;padding:6px 8px}
.nodo-assign-row+.nodo-assign-row,.nodo-assign-foot{box-shadow:inset 0 .5px 0 var(--dsw-alias-border-l2)}
.nodo-assign-head{min-height:44px;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:500}
.nodo-assign-type{display:flex;flex-direction:column;min-width:0}
.nodo-assign-type-top{display:flex;align-items:center;gap:4px}
.nodo-assign-type .nodo-type-input{height:26px;padding:0 4px;font-size:14px;font-weight:500}
.nodo-assign-type .nodo-type-sub{box-sizing:border-box;height:24px;max-height:120px;padding:2px 4px;resize:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.nodo-assign-remove,.nodo-assign-confirm{display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:22px;height:22px;padding:0 4px;border:0;border-radius:6px;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;cursor:pointer}
.nodo-assign-remove{opacity:0}
.nodo-pick>:is(.nodo-assign-remove,.nodo-assign-confirm){position:absolute;top:50%;right:8px;transform:translateY(-50%)}
.nodo-pick[data-removable] .nodo-pick-trigger{padding-right:46px}
.nodo-assign-row:hover .nodo-assign-remove,.nodo-assign-remove:focus-visible{opacity:1}
.nodo-assign-remove:hover:not(:disabled),.nodo-assign-confirm{color:var(--dsw-alias-state-error-primary)}
.nodo-pick{position:relative;min-width:0}
.nodo-pick-trigger{display:flex;align-items:center;gap:10px;width:100%;height:40px;padding:0 10px 0 8px;border:0;border-radius:10px;background:0 0;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font:inherit;text-align:left;cursor:pointer}
.nodo-pick-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nodo-pick-trigger:disabled{cursor:default}
.nodo-pick[data-warn] .nodo-pick-trigger{background:var(--dsw-alias-state-warn-tertiary);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,transparent)}
.nodo-pick[data-warn] .nodo-pick-name{color:${WARN_INK}}
.nodo-pick-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500}
.nodo-pick-none{width:24px;height:24px;flex:none;border-radius:8px;box-shadow:inset 0 0 0 1.5px var(--dsw-alias-border-l1)}
.nodo-pick-trigger>.nodo-team-model{flex:none;max-width:40%}
.nodo-pick-trigger>svg{transform:rotate(90deg)}
.nodo-pick-pop{position:absolute;z-index:20;top:calc(100% + 6px);left:0;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;width:320px;padding:12px;border-radius:14px;background:var(--dsw-alias-bg-base);box-shadow:0 0 0 .5px var(--dsw-alias-border-l2),var(--dsw-shadow-lv2)}
.nodo-pick-group{display:flex;flex-wrap:wrap;gap:4px}
.nodo-pick-label{margin-bottom:-4px;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:500;line-height:16px}
:is(.nodo-pick-group,.nodo-pick-models)+.nodo-pick-label{padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}
.nodo-pick-models{display:flex;flex-direction:column;gap:6px}
.nodo-pick-provider{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
.nodo-pick-group+.nodo-pick-provider{padding-top:4px}
.nodo-pick-option{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:0;border-radius:8px;background:0 0;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:500;cursor:pointer}
.nodo-pick-option:hover{color:var(--dsw-alias-label-primary)}
.nodo-pick-option[aria-pressed=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);box-shadow:none;color:var(--dsw-alias-state-business-primary)}
.nodo-assign-split{display:inline-flex;align-items:center;gap:6px;height:40px;padding:0 12px 0 8px;border:0;border-radius:10px;background:0 0;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;font-weight:500;cursor:pointer;width:100%}
.nodo-assign-split:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.nodo-assign-foot{display:flex;align-items:center;min-height:56px;padding:8px}
.nodo-assign-add{display:flex;align-items:center;gap:12px;flex:1;min-width:0}
.nodo-assign-field{display:flex;align-items:center;box-sizing:border-box;height:40px;border-radius:10px;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}
.nodo-assign-field:focus-within{box-shadow:inset 0 0 0 1.5px var(--dsw-alias-state-business-primary)}
.nodo-assign-field input,input.nodo-assign-field{min-width:0;height:38px;padding:0 12px;border:0;outline:0!important;background:none;color:inherit;font:inherit;font-size:13px}
.nodo-assign-field-name{width:180px;flex:none;border:0}
.nodo-assign-add>span.nodo-assign-field{flex:1;padding-right:8px;gap:4px}
.nodo-assign-add>span.nodo-assign-field>input{flex:1}
@media(max-width:720px){.nodo-assign-row{grid-template-columns:1fr;row-gap:8px}.nodo-assign-head{display:none}.nodo-team-tree{flex-direction:column;align-items:stretch;gap:8px}.nodo-team-lines{display:none}.nodo-team-col{width:auto}}
`
