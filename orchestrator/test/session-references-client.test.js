import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'

function harness() {
  const cleanups = []
  const listeners = new Set()
  const navigations = new Set()
  const requests = []
  const edits = []
  let active = true
  let current = 'target'
  let command, source
  const space = { getSnapshot: () => ({ active, legacy: false }), subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) } }
  const ctx = {
    effect: factory => cleanups.push(factory()),
    commandUi: { register: value => { command = value; return () => { command = null } } },
    inputTriggers: { registerSource: value => { source = value; return () => { source = null } } },
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: current }), subscribe: listener => { navigations.add(listener); return () => navigations.delete(listener) } } } },
    conversation: {},
  }
  const context = createContext({
    h: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
    Fragment: 'Fragment', useSyncExternalStore: (_subscribe, snapshot) => snapshot(), useEffect() {},
    useState: value => [value, () => {}], IconUsersOutlineRegular: 'Icon',
    call: async (endpoint, payload) => { requests.push({ endpoint, payload }); return { id: payload.id, target: payload.target } },
  })
  new Script(readFileSync(new URL('../src/client/session-references.js', import.meta.url), 'utf8')).runInContext(context)
  const ui = context.createSessionReferences(ctx, space)
  const input = { draft: '', phase: 'plain', draftRev: 11, occurrences: [] }
  return { ui, requests, edits, input, get command() { return command }, get source() { return source },
    render: () => ui.ReferenceDock({ sessionId: 'target', useInput: fn => fn(input), inputActions: { insertText: (...args) => edits.push(args) } }),
    activate(value) { active = value; for (const listener of listeners) listener() },
    navigate(value) { current = value; for (const listener of navigations) listener() },
    dispose() { for (const cleanup of cleanups) cleanup() },
  }
}

test('the native menu contribution is limited to Nodo and its picker closes on navigation', () => {
  const h = harness()
  assert.equal(h.command.label(), '引用会话')
  assert.equal(h.command.available(), true)
  h.command.ui.run({ sessionId: 'target' })
  assert.equal(h.render().children[0].type.name, 'ReferenceDialog')
  h.navigate('other')
  assert.equal(h.render().children.length, 0)
  h.activate(false)
  assert.equal(h.command.available(), false)
  assert.equal(h.render(), null)
  h.dispose()
  assert.equal(h.command, null)
  assert.equal(h.source, null)
})

test('native serialization retains its target when the user switches sessions during a send', async () => {
  const h = harness()
  const ref = JSON.stringify({ id: 'snapshot-id', target: 'target' })
  h.navigate('other')
  const serialized = await h.source.codec.serialize(ref, new AbortController().signal)
  assert.equal(serialized, '[引用会话](nodo-reference:snapshot-id)')
  assert.equal(h.requests[0].endpoint, 'reference-read')
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0].payload)), { id: 'snapshot-id', target: 'target' })
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(h.source.codec.serialize(ref, cancelled.signal), /abort/i)
  assert.equal(h.requests.length, 1)
  h.dispose()
})

test('removing a reference maps native chip coordinates without replacing text or other attachments', () => {
  const h = harness()
  h.input.occurrences = [
    { source: 'reference', offset: 2, length: 20 },
    { source: 'nodo-reference', ref: JSON.stringify({ id: 'snapshot', target: 'target' }), label: 'Planner · Plan', offset: 30, length: 60, occurrenceId: 2 },
  ]
  const rail = h.render().children[0]
  const remove = rail.children[0].children[1]
  assert.equal(remove.props['aria-label'], '移除引用 Planner · Plan')
  remove.props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(h.edits)), [['', { start: 11, end: 12, draftRev: 11 }]])
  h.dispose()
})

// The dialog's 来源角色 select pairs with 来源项目: either alone narrows the
// same session rows, and 全部角色 lifts the role side again.
test('the reference dialog narrows source sessions by the picked role', () => {
  const source = readFileSync(new URL('../src/client/session-references.js', import.meta.url), 'utf8')
  const slots = []
  slots[0] = { workspaces: [{ id: 'w', name: 'bot' }], profiles: [
    { id: 'fish', name: '大肥鱼', sessions: [{ id: 's1', name: '读当前任务', workspaceRef: 'w', updatedAt: 2 }] },
    { id: 'coder', name: '贼 coder', sessions: [{ id: 's2', name: '删除新会话', workspaceRef: 'w', updatedAt: 3 }] },
  ] }
  let cursor = 0
  const context = createContext({
    h: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
    useState: (initial) => {
      const slot = cursor++
      if (!(slot in slots)) slots[slot] = initial
      return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value }]
    },
    useEffect() {}, useSyncExternalStore: (_subscribe, snapshot) => snapshot(), Fragment: 'Fragment',
    Modal: 'Modal', Button: 'Button', Input: 'Input', MarkdownText: 'MarkdownText', MARKDOWN_LABELS: {},
    call: async () => ({}),
  })
  new Script(source.slice(source.indexOf('function ReferenceDialog('), source.indexOf('\n  function ReferenceDock('))).runInContext(context)
  const nodes = node => !node || typeof node !== 'object' ? []
    : [node, ...Object.values(node.props ?? {}).flatMap(nodes), ...(node.children ?? []).flatMap(nodes)]
  const render = () => { cursor = 0; return nodes(context.ReferenceDialog({ target: 't', snapshot: null, inputActions: {}, onClose: () => {} })) }
  const roleSelect = tree => tree.find(node => node.type === 'select' && node.props['aria-label'] === '来源角色')
  const rows = tree => tree.filter(node => node.props?.className === 'nodo-reference-row').map(node => node.children[0].children[0])
  let tree = render()
  assert.deepEqual(Array.from(roleSelect(tree).children, option => option.children[0]), ['全部角色', '大肥鱼', '贼 coder'])
  assert.deepEqual(rows(tree), ['贼 coder · 删除新会话', '大肥鱼 · 读当前任务'])
  roleSelect(tree).props.onChange({ target: { value: 'coder' } })
  tree = render()
  assert.deepEqual(rows(tree), ['贼 coder · 删除新会话'])
  roleSelect(tree).props.onChange({ target: { value: '' } })
  assert.deepEqual(rows(render()), ['贼 coder · 删除新会话', '大肥鱼 · 读当前任务'])
})

test('an unbound draft can select a legacy reply without accessing a native input', async () => {
  const source = readFileSync(new URL('../src/client/session-references.js', import.meta.url), 'utf8')
  const states = [], effects = new Map(), requests = [], picked = []
  let cursor = 0, pending = [], closed = 0
  const result = { source: { profileName: 'Planner', sessionName: 'Plan' }, messages: [{ id: 'reply', at: 1, text: 'Complete report' }] }
  const context = createContext({
    h: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
    useState: initial => { const at = cursor++; if (!(at in states)) states[at] = initial; return [states[at], value => { states[at] = value }] },
    useEffect: (effect, deps) => { const at = cursor++, before = effects.get(at); if (!before || deps.some((value, i) => value !== before[i])) { effects.set(at, deps); pending.push(effect) } },
    Modal: 'Modal', Fragment: 'Fragment', Button: 'Button', Input: 'Input', MarkdownText: 'MarkdownText', MARKDOWN_LABELS: {},
    call: async (endpoint, payload) => {
      requests.push({ endpoint, payload })
      if (endpoint === 'state') return { workspaces: [{ id: 'w' }], profiles: [{ id: 'p', name: 'Planner', sessions: [{ id: 's', name: 'Plan', workspaceRef: 'w', updatedAt: 1 }] }] }
      return endpoint === 'reference-create' ? { id: 'snapshot', ...result } : result
    },
  })
  new Script(source.slice(source.indexOf('function ReferenceDialog('), source.indexOf('\n  function ReferenceDock('))).runInContext(context)
  const all = node => node && typeof node === 'object' ? [node, ...Object.values(node.props ?? {}).flatMap(all), ...(node.children ?? []).flatMap(all)] : []
  const props = { draft: 'draft-id', workspaceId: 'w', onPick: value => picked.push(value), onClose: () => closed++ }
  const render = () => { cursor = 0; const tree = context.ReferenceDialog(props); const next = pending; pending = []; next.forEach(effect => effect()); return tree }
  render(); await new Promise(resolve => setImmediate(resolve))
  const row = all(render()).find(node => node.props.className === 'nodo-reference-row')
  assert.ok(row, 'a source without a native session is available before the target exists')
  row.props.onClick(); render(); await new Promise(resolve => setImmediate(resolve))
  const pick = () => all(render()).find(node => node.type === 'Button' && node.children.includes('引用这条回复'))
  assert.equal(pick().props.disabled, false)
  pick().props.onClick(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(picked[0].messages[0].text, 'Complete report')
  assert.equal(closed, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(requests.find(item => item.endpoint === 'reference-create').payload)), { draft: 'draft-id', profile: 'p', session: 's', messageId: 'reply' })
  props.count = 4
  pick().props.onClick(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests.filter(item => item.endpoint === 'reference-create').length, 1)
  assert.match(JSON.stringify(render()), /最多引用四条/)
})
