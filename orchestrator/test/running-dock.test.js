import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readPanelSource } from './helpers/client-source.js'
import { Script, createContext } from 'node:vm'

const source = readPanelSource()
const start = source.indexOf('  const conversation = () =>')
const end = source.indexOf('\n  const page = () =>', start)

// The slice is NodoPage's conversation, closed over the bindings the component
// derives above it: the composer takes the session-aware profile rather than the
// role card, and busy folds in a compaction running on this session. Both are
// stubbed, and the stub profile stays distinguishable from the card so the
// layout test also proves which one reaches the composer.
const profile = { id: 'coder', name: 'Coder' }
const composerProfile = { id: 'coder', name: 'Coder', model: 'session-model', thinking: 'high' }

function render(work) {
  const context = createContext({
    h: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(child => child !== false) }),
    Feed: 'Feed', RunningLine: 'RunningLine', Composer: 'Composer', SessionStats: 'SessionStats', RolePicker: 'RolePicker',
    profile, composerProfile, workspace: { id: 'w1' }, session: { id: 's1', name: 'Session' },
    sessionId: 's1', view: { revision: 1, work: {} }, sentTick: 0, work,
    drafts: {}, pastedImages: {}, draftKey: 's1', busy: false, sessionBusy: false, readOnly: false,
    runningOf: () => ({ active: false }), attach() {}, removeImage() {}, insertDraft() {},
  })
  new Script(`${source.slice(start, end)}\nthis.renderConversation = conversation`).runInContext(context)
  return context.renderConversation()
}

test('running clock stays outside the scrolling feed throughout streamed output', () => {
  for (const buffer of [null, '', '开始输出', '正文持续增长。'.repeat(1000)]) {
    const tree = render({ active: true, since: 1234, buffer })
    const children = Array.from(tree.children)
    const feed = children.findIndex(node => node?.type === 'Feed')
    const dock = children.findIndex(node => node?.props?.className === 'nodo-running-dock')
    const composer = children.findIndex(node => node?.type === 'Composer')
    assert.ok(feed < dock && dock < composer, 'the status has its own layout row above the composer')
    const status = children[dock].children[0]
    assert.equal(status.type, 'RunningLine')
    assert.equal(status.props.since, 1234, 'stream growth preserves the original elapsed clock')
    assert.equal(status.props.key, 's1')
    assert.equal(children[composer].props.profile, composerProfile, 'the composer keeps the profile derived for this session')
  }
})

test('the running dock disappears only after work becomes inactive', () => {
  for (const work of [undefined, { active: false, since: 1234, buffer: '已完成' }]) {
    const tree = render(work)
    assert.equal(tree.children.some(node => node?.props?.className === 'nodo-running-dock'), false)
  }
})
