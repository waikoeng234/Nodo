import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'

function harness({ groups = [], current = null, status = 'ready', error = null, subagent = false, active = true } = {}) {
  const selections = []
  const loads = []
  const registrations = []
  const listeners = new Set()
  let spaceState = { active, legacy: false }
  let dispose
  const space = {
    getSnapshot: () => spaceState,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  const state = { current, groups, failures: [], status, error, pending: null }
  const ctx = {
    sessions: { subagentAddress: () => (subagent ? 'sub' : undefined) },
    modelDirectories: {
      directoryFor(sessionId) {
        return {
          store: { subscribe: () => () => {}, getSnapshot: () => state },
          load: async () => { loads.push(sessionId); return state },
          select: async selection => { selections.push(selection); state.current = selection },
        }
      },
    },
    slots: {
      inject(_name, run) { dispose = run() },
      register(options, component) { const entry = { options, component }; registrations.push(entry); return () => registrations.splice(registrations.indexOf(entry), 1) },
    },
  }
  let cells = []
  let cursor = 0
  const context = createContext({
    h: (type, props, ...children) => ({ type, props, children: children.flat() }),
    useState(init) {
      const at = cursor++
      if (cells[at] === undefined) cells[at] = { value: typeof init === 'function' ? init() : init }
      const cell = cells[at]
      return [cell.value, value => { cell.value = typeof value === 'function' ? value(cell.value) : value }]
    },
    useSyncExternalStore: subscribe => { subscribe(() => {}); return state },
    useEffect(callback, deps) {
      const at = cursor++
      if (cells[at]?.deps.every((value, index) => value === deps[index])) return
      cells[at]?.stop?.()
      cells[at] = { deps, stop: callback() }
    },
    Menu: props => ({ type: 'Menu', props }),
    StateDot: props => ({ type: 'StateDot', props }),
    IconChevronDownOutlineRegular: { icon: 'chevron' },
    IconDataOutlineRegular: { icon: 'data' },
    IconChevronRightOutlineRegular: { icon: 'right' },
    modelName: raw => String(raw ?? ''),
    call: () => { throw new Error('The model seat uses the host directory') },
  })
  new Script(readFileSync(new URL('../src/client/model-seat.js', import.meta.url), 'utf8')).runInContext(context)
  const { ModelSeat } = context.createModelSeat(ctx, space)
  const render = () => { cursor = 0; return ModelSeat({ sessionId: 'session-1', locked: false }) }
  const flush = () => new Promise(resolve => setTimeout(resolve, 2))
  return { registrations, selections, loads, render, flush, dispose,
    setSpace(changes) { spaceState = { ...spaceState, ...changes }; for (const listener of listeners) listener() },
  }
}

const HOST_GROUP = { id: 'deepseek-account', name: 'DSH', models: [{ id: 'm1', name: 'DeepSeek Flash' }] }

test('the seat restores the native picker outside the Nodo native space and on disposal', () => {
  const h = harness({ active: false })
  assert.equal(h.registrations.length, 0, 'ordinary space must keep the host picker')
  h.setSpace({ active: true })
  assert.equal(h.registrations.length, 1)
  assert.equal(h.registrations[0].options.name, 'conversation.input.model')
  assert.equal(h.registrations[0].options.priority, -100)
  h.setSpace({ active: true })
  assert.equal(h.registrations.length, 1, 'repeated updates must not duplicate the seat')
  h.setSpace({ legacy: true })
  assert.equal(h.registrations.length, 0, 'the independent Nodo panel owns its own composer')
  h.setSpace({ legacy: false })
  assert.equal(h.registrations.length, 1)
  h.setSpace({ active: false })
  assert.equal(h.registrations.length, 0, 'returning to ordinary space releases the override')
  h.setSpace({ active: true })
  h.dispose()
  assert.equal(h.registrations.length, 0)
  h.setSpace({ active: false })
  h.setSpace({ active: true })
  assert.equal(h.registrations.length, 0, 'disposing also removes the space subscription')
})

test('a plain session lists the host provider directory', async () => {
  const h = harness({ groups: [HOST_GROUP] })
  let tree = h.render()
  tree.props.anchor.props.onClick()
  await h.flush()
  tree = h.render()
  assert.deepEqual(h.loads, ['session-1'], 'opening loads the shared host catalog')
  tree.props.onSelect('model')
  tree = h.render()
  const text = JSON.stringify(tree.props.items)
  assert.ok(text.includes('DSH') && text.includes('DeepSeek Flash'))
  assert.ok(!text.includes('Codex') && !text.includes('GPT'), 'another engine must never be offered here')
})

test('a dsh role session keeps the plain-session list', async () => {
  const h = harness({ groups: [HOST_GROUP] })
  let tree = h.render()
  tree.props.anchor.props.onClick()
  await h.flush()
  tree = h.render()
  tree.props.onSelect('model')
  tree = h.render()
  const text = JSON.stringify(tree.props.items)
  assert.ok(text.includes('DSH') && !text.includes('Codex'))
})

test('native providers named opencode or codex are not filtered out', async () => {
  const h = harness({ groups: [HOST_GROUP, { id: 'opencode', name: 'User OpenCode', models: [{ id: 'user-model', name: 'User model' }] }, { id: 'codex', name: 'User provider', models: [{ id: 'custom', name: 'Custom model' }] }] })
  let tree = h.render()
  tree.props.anchor.props.onClick()
  await h.flush()
  tree = h.render()
  tree.props.onSelect('model')
  assert.match(JSON.stringify(h.render().props.items), /User model/)
  assert.match(JSON.stringify(h.render().props.items), /Custom model/)
})

test('picks ride the native directory: model then reasoning effort', async () => {
  const h = harness({ groups: [HOST_GROUP], current: { provider: 'deepseek-account', model: 'm1' } })
  let tree = h.render()
  tree.props.anchor.props.onClick()
  await h.flush()
  tree = h.render()
  tree.props.onSelect(`model:${JSON.stringify(['deepseek-account', 'm1'])}`)
  assert.deepEqual(JSON.parse(JSON.stringify(h.selections)), [{ provider: 'deepseek-account', model: 'm1' }])
  tree = h.render()
  tree.props.onSelect('thinking:high')
  assert.deepEqual(JSON.parse(JSON.stringify(h.selections.at(-1))), { provider: 'deepseek-account', model: 'm1', reasoningEffort: 'high' })
  tree = h.render()
  tree.props.onSelect('thinking:')
  assert.deepEqual(JSON.parse(JSON.stringify(h.selections.at(-1))), { provider: 'deepseek-account', model: 'm1' }, 'the default level sends no effort key')
})

test('a subagent session renders no seat at all', () => {
  const h = harness({ subagent: true })
  assert.equal(h.render(), null)
})
