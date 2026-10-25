import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]

// The conversation area is rendered through the real NodoPage: the composer takes
// the session-aware profile rather than the role card, and busy folds in a
// compaction running on this session. The session carries a model and thinking so
// the derived profile stays distinguishable from the card.
const profile = { id: 'coder', name: 'Coder', sessions: [{ id: 's1', name: 'Session', model: 'session-model', thinking: 'high' }] }
const composerProfile = { ...profile, model: 'session-model', thinking: 'high' }

async function mount() {
  const slots = []
  let cursor = 0
  const navigation = { profile: 'coder', workspace: 'w1', sessions: { 'w1:coder': 's1' } }
  const view = { revision: 1, profiles: [profile], workspaces: [{ id: 'w1' }], work: {}, stats: {}, approvals: [] }
  const loaded = await loadClient(['page.js', 'session-rail.tsx', 'composer.js', 'feed.js', 'running.js', 'run-cards.js', 'role-seat.js'], {
    uiShared: {
      useStateView: () => ({ view, refresh: async () => {} }),
      readNavigation: () => navigation, subscribeNavigation() {},
      setNavigation: update => { navigation = update(navigation) },
      nativeSpace: { subscribe() {}, getSnapshot: () => ({ active: true, legacy: false }), showLegacy() {} },
      readNativeSession: () => null, subscribeNativeSession() {},
      completionTracker: { subscribe() {}, getSnapshot: () => ({}) },
      openNativeSession: null,
      runningOf: () => ({ active: false }),
      workLabel: () => '', sessionTime: () => '',
      call: async () => ({}),
    },
    react: {
      useState(initial) {
        const slot = cursor++
        if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
        return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value }]
      },
      useRef(initial) { const slot = cursor++; return slots[slot] ??= { current: initial } },
      useEffect() {},
    },
    globals: {
      document: { visibilityState: 'visible', hasFocus: () => true },
      localStorage: { getItem: () => null, setItem() {} },
    },
  })
  const conversationOf = node => node?.props?.className === 'nodo-conversation' ? node
    : (node?.children ?? []).flatMap(child => conversationOf(child)).find(Boolean)
  const render = work => {
    cursor = 0
    view.work = work ? { s1: work } : {}
    return conversationOf(loaded.NodoPage())
  }
  return { loaded, render }
}

test('running clock stays outside the scrolling feed throughout streamed output', async () => {
  const { loaded, render } = await mount()
  for (const buffer of [null, '', '开始输出', '正文持续增长。'.repeat(1000)]) {
    const tree = render({ active: true, since: 1234, buffer })
    const children = Array.from(tree.children)
    const feed = children.findIndex(node => node?.type === loaded.Feed)
    const dock = children.findIndex(node => node?.props?.className === 'nodo-running-dock')
    const composer = children.findIndex(node => node?.type === loaded.Composer)
    assert.ok(feed < dock && dock < composer, 'the status has its own layout row above the composer')
    const status = children[dock].children[0]
    assert.equal(status.type, loaded.RunningLine)
    assert.equal(status.props.since, 1234, 'stream growth preserves the original elapsed clock')
    assert.equal(status.props.key, 's1')
    assert.deepEqual(JSON.parse(JSON.stringify(children[composer].props.profile)), composerProfile, 'the composer keeps the profile derived for this session')
  }
})

test('the running dock disappears only after work becomes inactive', async () => {
  const { render } = await mount()
  for (const work of [undefined, { active: false, since: 1234, buffer: '已完成' }]) {
    const tree = render(work)
    assert.equal(tree.children.some(node => node?.props?.className === 'nodo-running-dock'), false)
  }
})
