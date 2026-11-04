import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...(tree.children ?? []).flatMap(nodes)]
const tick = () => new Promise(resolve => setImmediate(resolve))

test('Claude goal chip is a neutral label, without claiming a running or completed goal', async () => {
  const loaded = await loadClient('composer.js')
  const tree = nodes(loaded.Composer({ profile: { engine: 'claude', nativeGoal: 'All tests pass' }, value: '', images: [], onModelChange() {} }))
  const chip = tree.find(node => node.props.className === 'nodo-mode-chip')
  assert.deepEqual(chip.children.filter(child => typeof child === 'string'), ['目标'])
  assert.equal(chip.props.title, 'All tests pass')
  assert.equal(chip.props['aria-label'], '清除目标')
})

test('composer chips sit beside permissions, close their mode, and disappear when cleared', async () => {
  const loaded = await loadClient('composer.js')
  const changes = []
  const render = profile => {
    loaded.host.reset()
    return nodes(loaded.Composer({ profile, value: '', images: [], onModelChange: value => changes.push(JSON.parse(JSON.stringify(value))) }))
  }
  const active = render({ engine: 'codex', permission: 'plan', nativeGoal: 'Pass the checks' })
  const tools = active.find(node => node.props.className === 'nodo-composer-tools')
  assert.equal(tools.children[0].type, loaded.PermissionMenu)
  assert.deepEqual(tools.children.slice(1).map(node => node.props['aria-label']), ['清除目标'])
  tools.children[1].props.onClick()
  assert.deepEqual(changes, [{ nativeGoal: '' }])
  assert.equal(render({ engine: 'codex', permission: 'workspace' }).some(node => node.props.className === 'nodo-mode-chip'), false)
  const ref = { current: null }
  const permissions = await loadClient('composer.js', { react: { useRef: () => ref }, call: async () => [
    { id: 'codex', capabilities: { permissionModes: ['plan', 'workspace'] } },
    { id: 'pi', capabilities: { permissionModes: ['plan', 'full'] } },
  ] })
  const permission = (engine = 'codex') => {
    permissions.host.reset()
    const tree = nodes(permissions.PermissionMenu({ profile: { engine, permission: 'plan' }, onChange: value => changes.push(JSON.parse(JSON.stringify(value))) }))
    permissions.host.effects.splice(0).forEach(effect => effect())
    return tree
  }
  permission(); await tick()
  permission().find(node => node.props['aria-label'] === '关闭计划模式').props.onClick()
  assert.deepEqual(changes.at(-1), { permission: 'workspace' })
  permission('pi'); await tick()
  assert.equal(permission('pi').some(node => node.props.className === 'nodo-mode-chip'), false)
})

test('goal and plan actions obey capabilities and lead mode in both add and slash menus', async () => {
  const loaded = await loadClient('composer.js', { call: async endpoint => endpoint === 'engine-catalog'
    ? [{ id: 'claude', capabilities: { goals: true, permissionModes: ['plan', 'workspace'] } },
      { id: 'codebuddy', capabilities: { permissionModes: ['plan', 'workspace'] } },
      { id: 'pi', capabilities: { permissionModes: ['plan', 'full'] } }]
    : { source: 'fixture', commands: [] } })
  const render = (engine = 'claude', trigger = null, leadMode = false) => {
    loaded.host.reset()
    return loaded.AddMenu({ profile: { engine, lead: leadMode, leadMode }, trigger,
      onGoal() {}, onModelChange() {}, onInsert() {}, onToken() {} })
  }
  render().props.anchor.props.onClick()
  await tick(); await tick()
  assert.ok(render().props.items.some(item => item.id === 'goal'))
  assert.ok(render('claude', { char: '/', start: 0, query: 'goal' }).props.items.some(item => item.id === 'goal'))
  assert.ok(render('claude', { char: '/', start: 0, query: 'plan' }).props.items.some(item => item.id === 'plan'))
  assert.equal(render('claude', null, true).props.items.some(item => item.id === 'plan'), false)
  assert.equal(render('pi').props.items.some(item => item.id === 'goal' || item.id === 'plan'), false)
  assert.equal(render('codebuddy').props.items.some(item => item.id === 'goal'), false)
  assert.equal(render('codebuddy', { char: '/', start: 0, query: 'goal' }).props.items.some(item => item.id === 'goal'), false)
  assert.ok(render('codebuddy').props.items.some(item => item.id === 'plan'))
})

test('ExitPlanMode approval cards render plan text from both native input shapes', async () => {
  const loaded = await loadClient('run-cards.js')
  for (const detail of [{ input: { plan: '# Plan\nRun tests' } }, { toolCall: { rawInput: { plan: '# Plan\nRun tests' } } }]) {
    loaded.host.reset()
    const tree = nodes(loaded.ApprovalCard({ card: { id: 'plan', tool: 'ExitPlanMode', kind: 'permission', detail } }))
    assert.deepEqual(tree.find(node => node.props.className === 'nodo-approval-plan').children, ['# Plan\nRun tests'])
  }
})

test('approval cards name their task on the first line and stay plain without one', async () => {
  const loaded = await loadClient('run-cards.js')
  const strip = card => { loaded.host.reset(); return nodes(loaded.ApprovalCard({ card })).find(node => node.props.className === 'nodo-approval-strip') }
  assert.ok(strip({ id: 'p1', tool: 'bash', kind: 'permission', taskTitle: 'Fix login' }).children
    .some(child => child.props?.className === 'nodo-approval-task' && child.children[0] === 'Fix login'))
  assert.equal(nodes(loaded.ApprovalCard({ card: { id: 'p2', tool: 'bash', kind: 'permission' } }))
    .some(node => node.props.className === 'nodo-approval-task'), false, 'a card without a task keeps its plain first line')
  const ask = nodes(loaded.ApprovalCard({ card: { id: 'q1', kind: 'question', taskTitle: 'Fix login',
    detail: { questions: [{ id: 'a', header: '确认', question: '继续？', options: [{ label: '好' }] }] } } }))
  assert.equal(ask.find(node => node.props.className === 'nodo-question-eyebrow').children[0], 'Fix login')
})
