import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
const tick = () => new Promise(resolve => setImmediate(resolve))
const engines = [
  { id: 'claude', capabilities: { permissionModes: ['plan', 'workspace', 'full'] }, catalog: { models: [] } },
  { id: 'codex', capabilities: { permissionModes: ['plan', 'workspace', 'full'] }, catalog: { models: [] } },
  { id: 'first', capabilities: { permissionModes: ['plan', 'full'] }, catalog: { models: [] } },
  { id: 'dsh', capabilities: { permissionModes: [] }, catalog: { models: [] } },
]

test('shared permission select uses native glyphs, gates full access and disables empty catalogs', async () => {
  const changes = []
  const { PermissionSelect, usePermissionChange, host } = await loadClient('composer.js')
  const render = (modes = engines[0].capabilities.permissionModes) => {
    host.reset()
    const { pick, confirmation } = usePermissionChange(false)
    return [...nodes(PermissionSelect({ modes, value: 'workspace', onChange: mode => pick(mode, 'workspace', mode => changes.push(mode)) })), ...nodes(confirmation)]
  }
  const select = () => render().find(node => node.type === 'select')
  assert.deepEqual(select().children.map(node => node.props.value), ['plan', 'workspace', 'full'])
  assert.ok(render().some(node => node.type === 'PermissionIconWorkspaceWriteRegular'))
  select().props.onChange({ target: { value: 'full' } })
  let risk = render().find(node => node.type === 'RiskConfirmation')
  assert.equal(risk.props.acknowledged, false)
  assert.deepEqual(changes, [])
  risk.props.onCancel()
  assert.equal(render().some(node => node.type === 'RiskConfirmation'), false)
  select().props.onChange({ target: { value: 'full' } })
  risk = render().find(node => node.type === 'RiskConfirmation')
  risk.props.onAcknowledgedChange(true)
  risk = render().find(node => node.type === 'RiskConfirmation')
  assert.equal(risk.props.acknowledged, true)
  risk.props.onConfirm()
  assert.deepEqual(changes, ['full'])
  select().props.onChange({ target: { value: 'plan' } })
  assert.deepEqual(changes, ['full', 'plan'])
  const empty = render([]).find(node => node.type === 'select')
  assert.equal(empty.props.disabled, true)
  assert.equal(empty.children[0].props.disabled, true)
  assert.deepEqual(empty.children[0].children, ['无可用权限档位'])
})

test('role editor saves permission for either role kind and recalibrates a new role on engine changes', async () => {
  for (const lead of [false, true, undefined]) {
    const calls = []
    const loaded = await loadClient(['profile-dialogs.js', 'composer.js'], { call: async (endpoint, payload) => {
      calls.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) })
      return endpoint === 'engine-catalog' ? engines : { id: 'role' }
    } })
    const profile = lead === undefined ? null : { id: 'role', name: 'Role', engine: 'codex', permission: 'workspace', lead }
    const render = () => {
      loaded.host.reset()
      const tree = nodes(loaded.RoleEditor({ profile, onSaved() {} }))
      loaded.host.effects.splice(0).forEach(effect => effect())
      return tree
    }
    const permission = () => render().find(node => node.type === loaded.PermissionSelect)
    render(); await tick()
    assert.equal(permission().props.value, 'workspace')
    permission().props.onChange('full')
    const risk = render().find(node => node.type === 'RiskConfirmation')
    assert.ok(risk)
    assert.equal(nodes(render().find(node => node.type === 'form')).some(node => node.type === 'RiskConfirmation'), false,
      'even a non-portaled submit button in the confirmation has no role form ancestor')
    assert.equal(permission().props.value, 'workspace')
    risk.props.onConfirm()
    assert.equal(permission().props.value, 'full')
    assert.equal(calls.some(call => /^profile-(create|update)$/.test(call.endpoint)), false, 'confirmation only changes the draft')
    if (!profile) {
      const agent = () => render().find(node => node.type === 'select' && node.props.value === 'claude')
      agent().props.onChange({ target: { value: 'first' } })
      assert.equal(permission().props.value, 'plan')
      render().find(node => node.type === 'select' && node.props.value === 'first').props.onChange({ target: { value: 'dsh' } })
      assert.equal(permission().props.value, undefined)
      assert.deepEqual([...permission().props.modes], [])
      render().find(node => node.type === 'select' && node.props.value === 'dsh').props.onChange({ target: { value: 'codex' } })
      render().find(node => node.type === 'input' && node.props.maxLength === 40).props.onChange({ target: { value: 'New role' } })
    }
    if (lead === true) assert.deepEqual([...permission().props.modes], ['workspace', 'full'], 'the lead editor offers no plan tier')
    permission().props.onChange(lead === true ? 'workspace' : 'plan')
    await render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
    const saved = calls.at(-1)
    assert.equal(saved.endpoint, profile ? 'profile-update' : 'profile-create')
    assert.equal((profile ? saved.payload.changes : saved.payload).permission, lead === true ? 'workspace' : 'plan')
  }
})

test('both create rows submit chosen permissions and reset them for another engine', async () => {
  for (const lead of [false, true]) {
    const calls = []
    const view = { profiles: [{ id: 'worker', name: 'Worker', engine: 'codex', permission: 'workspace', sessions: [] }] }
    const loaded = await loadClient(['roles.tsx', 'composer.js'], { call: async (endpoint, payload) => {
      calls.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) })
      return endpoint === 'engine-catalog' ? engines : { id: 'new' }
    } })
    const render = () => {
      loaded.host.reset()
      const tree = nodes(loaded.RolesPage({ view, readOnly: false, refresh: async () => {} }))
      loaded.host.effects.splice(0).forEach(effect => effect())
      return tree
    }
    render(); await tick()
    render().find(node => node.type === 'button' && node.children.includes(lead ? '添加主控' : '添加角色')).props.onClick()
    const form = () => render().find(node => node.type === 'form')
    const permission = () => nodes(form()).find(node => node.type === loaded.PermissionSelect)
    assert.equal(permission().props.value, 'workspace')
    permission().props.onChange('full')
    const risk = render().find(node => node.type === 'RiskConfirmation')
    assert.ok(risk)
    assert.equal(nodes(form()).some(node => node.type === 'RiskConfirmation'), false,
      'the shared confirmation lives outside either create form')
    assert.equal(permission().props.value, 'workspace')
    risk.props.onConfirm()
    assert.equal(permission().props.value, 'full')
    assert.equal(calls.some(call => call.endpoint === 'profile-create'), false)
    const agent = () => nodes(form()).find(node => node.props['aria-label'] === 'Agent')
    if (lead) {
      assert.deepEqual(agent().children.filter(option => option.props?.value).map(option => option.props.value), ['claude', 'codex'],
        'the lead row only offers whitelisted engines')
      assert.deepEqual([...permission().props.modes], ['workspace', 'full'], 'the lead row offers no plan tier')
    } else {
      agent().props.onChange({ target: { value: 'first' } })
      assert.equal(permission().props.value, 'plan')
      agent().props.onChange({ target: { value: 'dsh' } })
      assert.equal(permission().props.value, undefined)
      agent().props.onChange({ target: { value: 'codex' } })
      assert.equal(permission().props.value, 'workspace')
      permission().props.onChange('plan')
    }
    agent().props.onChange({ target: { value: 'claude' } })
    permission().props.onChange(lead ? 'workspace' : 'plan')
    nodes(form()).find(node => node.props['aria-label'] === '名字').props.onChange({ target: { value: 'Created' } })
    form().props.onSubmit({ preventDefault() {} }); await tick()
    const saved = calls.find(call => call.endpoint === 'profile-create')
    assert.equal(saved.payload.permission, lead ? 'workspace' : 'plan')
    assert.equal(saved.payload.engine, 'claude')
    assert.equal(saved.payload.lead === true, lead)
  }
})

test('each role row saves permission immediately, rolls back failures and locks read-only or running roles', async () => {
  const calls = []
  let rejectSave
  const view = { profiles: [
    { id: 'worker', name: 'Worker', engine: 'codex', permission: 'workspace', sessions: [{ id: 's1', workspaceRef: 'ws' }] },
    { id: 'lead', name: 'Lead', engine: 'codex', permission: 'plan', lead: true, sessions: [] },
  ], workspaces: [{ id: 'ws' }], work: {} }
  const loaded = await loadClient(['roles.tsx', 'composer.js'], { call: async (endpoint, payload) => {
    calls.push({ endpoint, payload: payload && JSON.parse(JSON.stringify(payload)) })
    if (endpoint === 'engine-catalog') return engines
    if (payload.id === 'worker') return new Promise((_resolve, reject) => { rejectSave = reject })
    view.profiles.find(role => role.id === payload.id).permission = payload.changes.permission
    return {}
  } })
  const render = (readOnly = false) => {
    loaded.host.reset()
    const tree = nodes(loaded.RolesPage({ view, readOnly, refresh: async () => {} }))
    loaded.host.effects.splice(0).forEach(effect => effect())
    return tree
  }
  const field = (name, readOnly) => render(readOnly).find(node => node.type === loaded.PermissionSelect && node.props.label === `权限 ${name}`)
  render(); await tick()
  const leadTiers = () => { const cell = field('Lead'); return nodes(cell.type(cell.props)).find(node => node.type === 'select').children }
  assert.equal(field('Lead').props.value, 'plan')
  assert.deepEqual(leadTiers().filter(option => option.props.disabled).map(option => option.props.value), ['plan'],
    'the saved plan tier still shows, disabled, instead of another tier standing in')
  assert.deepEqual(leadTiers().filter(option => !option.props.disabled).map(option => option.props.value), ['workspace', 'full'])
  field('Worker').props.onChange('plan')
  assert.equal(field('Worker').props.value, 'plan')
  assert.equal(field('Worker').props.disabled, true)
  rejectSave(new Error('permission save refused')); await tick()
  assert.equal(field('Worker').props.value, 'workspace')
  assert.ok(render().some(node => node.props.role === 'alert' && node.children.includes('permission save refused')))
  field('Lead').props.onChange('workspace'); await tick()
  assert.equal(field('Lead').props.value, 'workspace')
  assert.deepEqual(calls.filter(call => call.endpoint === 'profile-update').map(call => call.payload), [
    { id: 'worker', changes: { permission: 'plan' } }, { id: 'lead', changes: { permission: 'workspace' } },
  ])
  assert.equal(field('Worker', true).props.disabled, true)
  view.work.s1 = { active: true }
  assert.equal(field('Worker').props.disabled, true)
})
