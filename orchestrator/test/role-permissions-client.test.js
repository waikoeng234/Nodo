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

test('the create button opens a blank role editor', async () => {
  const view = { profiles: [{ id: 'worker', name: 'Worker', engine: 'codex', permission: 'workspace', sessions: [] }] }
  const loaded = await loadClient(['roles.tsx', 'profile-dialogs.js', 'composer.js'], { call: async endpoint => endpoint === 'engine-catalog' ? engines : {} })
  const render = () => {
    loaded.host.reset()
    const tree = nodes(loaded.RolesPage({ view, readOnly: false, refresh: async () => {} }))
    loaded.host.effects.splice(0).forEach(effect => effect())
    return tree
  }
  render(); await tick()
  assert.equal(render().some(node => node.type === loaded.RoleEditor), false)
  render().find(node => node.props?.createButton).props.createButton.props.onClick()
  assert.equal(render().find(node => node.type === loaded.RoleEditor)?.props.profile, null)
})
