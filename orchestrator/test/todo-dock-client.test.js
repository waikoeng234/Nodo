import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

// PlanDock reads its lines from the shared store; tests seed it with this stub.
const liveStub = feed => ({
  transcriptOf: key => feed.lines, transcriptError: () => feed.error ?? '',
  pullTranscript: async () => {}, watchTranscript: () => () => {}, subscribeStore: () => () => {}, getStoreVersion: () => 0,
})
const nodes = node => !node || typeof node !== 'object' ? [] : [node,
  ...[...(node.children ?? []), node.props?.children].flat(Infinity).flatMap(nodes)]

const TODOS = [
  { text: 'one', status: 'completed' }, { text: 'two', status: 'in_progress' }, { text: 'three', status: 'pending' },
]

test('PlanDock hides without a current plan and shows the collapsed header with counts', async () => {
  const feed = { lines: [{ who: 'user', text: 'task' }] }
  const { PlanDock, host } = await loadClient('todo-dock.js', { stubs: { 'live.js': liveStub(feed) } })
  assert.equal(PlanDock({ profileId: 'p', sessionId: 's' }), null)
  feed.lines = [...feed.lines, { who: 'agent', kind: 'plan', steps: TODOS }]
  host.reset()
  const tree = PlanDock({ profileId: 'p', sessionId: 's' })
  assert.equal(tree.props.className, 'nodo-todo-dock')
  const head = nodes(tree).find(node => node.props.className === 'nodo-todo-dock-head')
  assert.equal(head.props['aria-expanded'], false)
  assert.equal(nodes(tree).find(node => node.props.className === 'nodo-todo-dock-progress').children[0],
    '已完成 1 · 进行中 1 · 待办 1')
  assert.equal(nodes(tree).some(node => node.type === 'ul'), false, 'collapsed by default')
  host.reset()
  assert.equal(PlanDock({ profileId: 'p', sessionId: 's', compact: true }).props['data-compact'], '')
})

test('PlanDock expands to the StateDot list and clears on removal', async () => {
  const feed = { lines: [{ who: 'agent', kind: 'plan', steps: TODOS }] }
  const { PlanDock, host } = await loadClient('todo-dock.js', { stubs: { 'live.js': liveStub(feed) } })
  const head = nodes(PlanDock({ profileId: 'p', sessionId: 's' })).find(node => node.props.className === 'nodo-todo-dock-head')
  head.props.onClick()
  host.reset()
  const items = nodes(nodes(PlanDock({ profileId: 'p', sessionId: 's' })).find(node => node.type === 'ul'))
    .filter(node => node.type === 'li')
  assert.deepEqual(items.map(item => item.props['data-status']), ['completed', 'in_progress', 'pending'])
  assert.deepEqual(items.map(item => item.children.find(child => child.props?.className === 'nodo-todo-dock-glyph').children[0].type),
    ['StateDot', 'StateDot', 'StateDot'])
  feed.lines = [{ who: 'agent', kind: 'plan', removed: true, steps: [] }]
  assert.equal(PlanDock({ profileId: 'p', sessionId: 's' }), null)
})
