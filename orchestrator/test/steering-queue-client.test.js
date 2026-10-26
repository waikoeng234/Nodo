import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree,
  ...[...(tree.children ?? []), tree.props?.children].flat(Infinity).flatMap(nodes)]

test('queued messages sit above the draft and expose edit, send now and delete without submitting', async () => {
  const { Composer, PendingMessages } = await loadClient('composer.js')
  const items = [{ seq: 4, text: 'Queued text', images: [], sending: false }]
  const calls = []
  const tree = Composer({ value: 'Draft', images: [], pending: items, onQueueAction: (...args) => calls.push(args) })
  const queue = tree.children[0]
  assert.equal(queue.type, PendingMessages)
  assert.equal(queue.props.items, items)
  const buttons = nodes(PendingMessages(queue.props)).filter(node => node.type === 'button')
  assert.deepEqual(buttons.map(button => button.children[0]), ['编辑', '立即发送', '删除'])
  for (const button of buttons) { assert.equal(button.props.type, 'button'); button.props.onClick() }
  assert.deepEqual(calls, [[4, 'edit'], [4, 'send'], [4, 'delete']])
  for (const disabled of [true, false]) {
    const row = PendingMessages({ items: [{ ...items[0], sending: !disabled }], disabled })
    assert.ok(nodes(row).filter(node => node.type === 'button').every(button => button.props.disabled))
  }
})

test('a running composer queues a nonempty draft by click or Enter and keeps a separate stop control', async () => {
  const { Composer } = await loadClient('composer.js')
  let sends = 0, stops = 0
  const tree = Composer({ value: 'Next', images: [], running: true, onSend: () => sends++, onStop: () => stops++ })
  const send = nodes(tree).find(node => node.props.className === 'nodo-send')
  assert.equal(send.props.type, 'submit')
  assert.equal(send.props['aria-label'], '加入队列')
  tree.props.onSubmit({ preventDefault() {} })
  nodes(tree).find(node => node.type === 'textarea').props.onKeyDown({ key: 'Enter', preventDefault() {} })
  nodes(tree).find(node => node.props.className === 'nodo-pending-stop').props.onClick()
  assert.equal(sends, 2)
  assert.equal(stops, 1)
})

test('the conversation sends in queue mode and restores edited text and images without overwriting its draft', async () => {
  const space = { active: true, legacy: true }
  const pending = [{ seq: 2, text: 'Queued', images: [], sending: false }]
  const view = { profiles: [{ id: 'role', engine: 'codex', sessions: [{ id: 'session', workspaceRef: 'workspace' }] }],
    workspaces: [{ id: 'workspace' }], work: { session: { active: true, pending } }, prefs: { onboardedAt: 1 } }
  const calls = []
  const loaded = await loadClient(['page.js', 'composer.js'], {
    uiShared: {
      useStateView: () => ({ view, refresh: async () => {} }),
      nativeSpace: { subscribe() {}, getSnapshot: () => space },
      completionTracker: { subscribe() {}, getSnapshot: () => ({}) },
      subscribeNativeSession() {}, readNativeSession: () => null,
      call: async (endpoint, payload) => {
        calls.push({ endpoint, ...JSON.parse(JSON.stringify(payload)) })
        if (endpoint === 'queued-message' && payload.action === 'edit') return {
          text: 'Queued', images: [{ name: 'image.png', mediaType: 'image/png', data: 'AQID' }],
        }
        return { mode: 'queued' }
      },
    },
    globals: {
      document: { visibilityState: 'visible', hasFocus: () => true },
      localStorage: { getItem: key => key === 'nodo.navigation'
        ? JSON.stringify({ profile: 'role', workspace: 'workspace', sessions: { 'workspace:role': 'session' } }) : null },
    },
  })
  const render = () => { loaded.host.reset(); return loaded.NodoPage({ contentOnly: true }) }
  const composer = () => nodes(render()).find(node => node.type === loaded.Composer).props
  const tick = () => new Promise(resolve => setImmediate(resolve))
  composer().onChange('Draft')
  assert.equal(composer().pending, pending)
  composer().onQueueAction(2, 'edit')
  await tick()
  assert.equal(composer().value, 'Queued\n\nDraft')
  assert.equal(composer().images[0].dataUrl, 'data:image/png;base64,AQID')
  composer().onSend()
  await tick()
  const request = calls.find(call => call.endpoint === 'send')
  assert.deepEqual(request, { endpoint: 'send', profile: 'role', session: 'session', text: 'Queued\n\nDraft',
    images: [{ name: 'image.png', mediaType: 'image/png', data: 'AQID' }], mode: 'queue' })
  assert.equal(composer().value, '')
  composer().onQueueAction(2, 'send')
  await tick()
  assert.ok(nodes(render()).some(node => node.props.role === 'alert' && node.children.includes('当前无法插入本轮，消息仍在排队')))
})
