import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'

const source = readFileSync(new URL('../src/client/running.js', import.meta.url), 'utf8')
const context = createContext({
  AVATAR_TEMPLATES: [],
  h: (type, props, ...children) => ({ type, props, children }),
  useSyncExternalStore: (_subscribe, read) => read(),
  nativeSpace: { subscribe() {}, getSnapshot: () => context.space },
  useStateView: () => ({ view: context.view }),
})
new Script(source).runInContext(context)
const snapshot = turns => ({ views: { get: () => ({ timeline: { turns: new Map(turns.map(turn => [turn.turn, turn])) } }) } })
const previous = { turn: 3, status: 'closed', start: { time: 1000 } }
const current = { turn: 4, status: 'open', start: { time: 9000 } }

test('native running clock uses the latest host turn and never reuses a closed turn clock', () => {
  assert.equal(context.nativeRunningSince(snapshot([current, previous])), 9000)
  assert.equal(context.nativeRunningSince(snapshot([previous, { ...current, status: 'closed' }])), undefined)
  assert.equal(context.nativeRunningSince(snapshot([previous, { ...current, start: undefined }])), undefined)
  assert.equal(context.nativeRunningSince({ views: { get: () => undefined } }), undefined)
})

test('native animation appears only for a running session in the native Nodo space', () => {
  const props = { sessionId: 'native-role-session', useSession: select => select({ running: true }), useConversation: select => select(snapshot([previous, current])) }
  context.space = { active: true, legacy: false }
  const dock = context.NativeRunningDock(props)
  assert.equal(dock.props['data-nodo-native-running'], '')
  assert.equal(dock.children[0].props.since, 9000)
  assert.equal(dock.children[0].props.key, props.sessionId)
  assert.equal(context.NativeRunningDock({ ...props, useSession: select => select({ running: false }) }), null)
  for (const space of [{ active: false, legacy: false }, { active: true, legacy: true }]) {
    context.space = space
    assert.equal(context.NativeRunningDock(props), null)
  }
})

test('native running status selects the current session engine health from the polled work view', () => {
  context.space = { active: true, legacy: false }
  context.view = { profiles: [{ sessions: [{ id: 'local', engine: 'dsh', driverSessionId: 'native' }, { id: 'other', engine: 'dsh', driverSessionId: 'foreign' }] }],
    work: { local: { engine: { phase: 'tool', tool: 'read', lastEventAt: 9000 } }, other: { engine: { phase: 'thinking' } } } }
  const props = { sessionId: 'native', useSession: select => select({ running: true }), useConversation: select => select(snapshot([current])) }
  const engine = context.NativeRunningDock(props).children[0].props.engine
  assert.equal(engine.tool, 'read')
  assert.equal(engine.lastEventAt, 9000)
  assert.match(context.engineRunningLabel(engine, 39000), /正在执行 read · 30s 未收到新事件/)
  assert.equal(context.engineRunningLabel({ ...engine, phase: 'waiting-approval' }, 10000), '等待审批')
  assert.equal(context.engineRunningLabel({ ...engine, phase: 'waiting-question' }, 10000), '等待回答')
  assert.equal(context.engineRunningLabel({ ...engine, phase: 'retrying', detail: 'Reconnecting... 2/5' }, 10000), '正在重试（Reconnecting... 2/5）')
  assert.equal(context.engineRunningLabel({ ...engine, phase: 'compacting' }, 10000), '正在压缩上下文')
  assert.equal(context.engineRunningLabel(undefined, 90000), '正在思考')
})

test('native running ignores stale external session pointers', () => {
  context.space = { active: true, legacy: false }
  context.view = { profiles: [{ sessions: [{ id: 'local', nativeSessionId: 'native', engine: 'zcode' }] }], work: {} }
  const props = { sessionId: 'native', useSession: select => select({ running: true }), useConversation: select => select(snapshot([current])) }
  const engine = context.NativeRunningDock(props).children[0].props.engine
  assert.equal(engine, undefined)
  context.view.profiles[0].sessions[0].engine = 'dsh'
  assert.equal(context.NativeRunningDock(props).children[0].props.engine, undefined)
})
