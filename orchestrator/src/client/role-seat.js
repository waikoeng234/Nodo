import { h, useState, Menu, IconChevronDownOutlineRegular, IconUsersOutlineRegular, useStateView } from './ui-shared.js'
import { RoleAvatar } from './avatar.tsx'

export function RolePicker({ profiles, profile, disabled, onSelect }) {
  profiles = profiles.filter(role => !role.deletedAt)
  const [open, setOpen] = useState(false)
  const name = profile?.name ?? '选择角色'
  const face = [profile && h(RoleAvatar, { profile, size: 20 }), h('span', { className: 'nodo-role-seat-label' }, name)]
  if (!onSelect) return profile ? h('span', { className: 'nodo-role-seat nodo-role-seat-fixed',
    'aria-label': `会话角色：${name}，不可修改`, title: '会话角色已固定' }, ...face) : null
  return h(Menu, {
    open, onClose: () => setOpen(false), portal: true, side: 'top', align: 'end',
    className: 'nodo-role-seat', listClassName: 'nodo-role-seat-list', selectedId: profile?.id,
    items: profiles.length ? profiles.map(role => ({ id: role.id, label: role.name,
      icon: h(RoleAvatar, { profile: role, size: 20 }), disabled })) : [{ type: 'label', id: 'empty', text: '请先添加角色' }],
    onSelect: id => { if (!disabled && profiles.some(role => role.id === id)) { onSelect(id); setOpen(false) } },
    anchor: h('button', { type: 'button', className: 'nodo-role-seat-trigger', disabled,
      'data-nodo-role-seat': true, 'aria-haspopup': 'menu', 'aria-expanded': open,
      'aria-label': `选择角色，当前 ${name}`, onClick: () => setOpen(value => !value) },
    ...face, h(IconChevronDownOutlineRegular, { size: 14 })),
  })
}

// One message's executor pick for a lead conversation: 自动 first, then the
// roster; the pick rides that one send and returns to 自动 afterwards.
export function AssigneePicker({ roster, value, disabled, onSelect }) {
  roster = roster.filter(role => !role.deletedAt)
  const [open, setOpen] = useState(false)
  const chosen = roster.find(role => role.id === value)
  const name = chosen?.name ?? '自动'
  const face = [chosen ? h(RoleAvatar, { profile: chosen, size: 20 }) : h(IconUsersOutlineRegular, { size: 16 }),
    h('span', { className: 'nodo-role-seat-label' }, name)]
  return h(Menu, {
    open, onClose: () => setOpen(false), portal: true, side: 'top', align: 'end',
    className: 'nodo-role-seat', listClassName: 'nodo-role-seat-list', selectedId: value ?? '',
    items: [{ id: '', label: '自动', icon: h(IconUsersOutlineRegular) },
      ...roster.map(role => ({ id: role.id, label: role.name, icon: h(RoleAvatar, { profile: role, size: 20 }) }))],
    onSelect: id => { if (!disabled) { onSelect(id || undefined); setOpen(false) } },
    anchor: h('button', { type: 'button', className: 'nodo-role-seat-trigger', disabled,
      'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-label': `执行者：${name}`, onClick: () => setOpen(state => !state) },
    ...face, h(IconChevronDownOutlineRegular, { size: 14 })),
  })
}

export function createRoleSeat(ctx, space) {
  function RoleSeat({ sessionId }) {
    const { view } = useStateView()
    const profile = view?.profiles.find(role => !role.deletedAt && role.sessions.some(session =>
      (session.engine === 'dsh' ? session.driverSessionId : undefined) === sessionId))
    if (typeof ctx.sessions.subagentAddress === 'function' && ctx.sessions.subagentAddress(sessionId) !== undefined) return null
    return h(RolePicker, { profiles: view?.profiles ?? [], profile })
  }
  ctx.slots.inject('conversation.input.right', () => {
    let unregister
    const update = () => {
      const state = space.getSnapshot()
      if (state.active && !state.legacy && !unregister) unregister = ctx.slots.register({ name: 'conversation.input.right', id: 'nodo-role' }, RoleSeat)
      else if ((!state.active || state.legacy) && unregister) { unregister(); unregister = null }
    }
    const stop = space.subscribe(update)
    update()
    return () => { stop(); unregister?.() }
  })
  return { RoleSeat }
}
