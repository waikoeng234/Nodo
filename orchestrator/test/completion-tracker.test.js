import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'

const source = readFileSync(new URL('../src/client/completion-tracker.js', import.meta.url), 'utf8')
function setup(storage = new Map()) {
  const events = new EventTarget()
  const context = createContext({})
  new Script(source).runInContext(context)
  const tracker = context.createCompletionTracker({ getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, events)
  return { tracker, events, storage }
}

test('viewing a completion persists its sequence across reloads and leaves later results unread', () => {
  const { tracker, storage } = setup()
  let updates = 0
  tracker.subscribe(() => updates++)
  tracker.mark('conversation', 10)
  tracker.mark('conversation', 9)
  tracker.mark('conversation', null)
  assert.equal(updates, 1)
  tracker.dispose()
  const restored = setup(storage).tracker
  assert.equal(restored.getSnapshot().conversation, 10)
  assert.ok(restored.getSnapshot().conversation < 11, 'a later host completion has a new sequence')
  restored.mark('conversation', 11)
  assert.equal(restored.getSnapshot().conversation, 11)
  restored.dispose()
})

test('read markers follow other windows and preserve a newer watermark when marking another session', () => {
  const { tracker, storage, events } = setup()
  tracker.mark('one', 10)
  storage.set('nodo.completions.seen', JSON.stringify({ one: 20 }))
  tracker.mark('two', 5)
  assert.equal(tracker.getSnapshot().one, 20)
  storage.set('nodo.completions.seen', JSON.stringify({ one: 30, two: 5 }))
  events.dispatchEvent(Object.assign(new Event('storage'), { key: 'nodo.completions.seen' }))
  assert.equal(tracker.getSnapshot().one, 30)
  tracker.dispose()
})

test('unavailable or malformed local storage does not prevent reading a conversation', () => {
  const { tracker, storage } = setup(new Map([['nodo.completions.seen', '{broken']]))
  tracker.mark('one', 0)
  assert.equal(JSON.parse(storage.get('nodo.completions.seen')).one, 0)
  tracker.dispose()
  const context = createContext({})
  new Script(source).runInContext(context)
  const blocked = context.createCompletionTracker({ getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }, {})
  blocked.mark('one', 10)
  assert.equal(blocked.getSnapshot().one, 10)
  blocked.dispose()
})
