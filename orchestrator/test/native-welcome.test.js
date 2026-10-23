import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'

function harness(sessions) {
  let selected = null
  let spaceState = { active: false, legacy: false }
  const sessionListeners = new Set()
  const currentListeners = new Set()
  const spaceListeners = new Set()
  const registrations = []
  const ctx = {
    sessions: { list: {
      getSnapshot: () => ({ byId: sessions }),
      subscribe: listener => { sessionListeners.add(listener); return () => sessionListeners.delete(listener) } } },
    uiSession: { adapter: { current: {
      getSnapshot: () => ({ key: selected }),
      subscribe: listener => { currentListeners.add(listener); return () => currentListeners.delete(listener) } } } },
    slots: { register(options, component) {
      const entry = { options, component }
      registrations.push(entry)
      return () => registrations.splice(registrations.indexOf(entry), 1)
    } },
  }
  const space = {
    getSnapshot: () => spaceState,
    subscribe: listener => { spaceListeners.add(listener); return () => spaceListeners.delete(listener) },
  }
  const context = createContext({})
  new Script(readFileSync(new URL('../src/client/native-welcome.js', import.meta.url), 'utf8')).runInContext(context)
  const Welcome = () => null
  const unmount = context.createNativeWelcome(ctx, space, Welcome)()
  return {
    registrations,
    enter() { spaceState = { ...spaceState, active: true }; for (const listener of spaceListeners) listener() },
    leave() { spaceState = { ...spaceState, active: false }; for (const listener of spaceListeners) listener() },
    draft(drafting) { spaceState = { ...spaceState, drafting }; for (const listener of spaceListeners) listener() },
    goLegacy() { spaceState = { ...spaceState, legacy: true }; for (const listener of spaceListeners) listener() },
    open(id) { selected = id; for (const listener of currentListeners) listener() },
    send(id) { sessions[id] = { ...sessions[id], blank: false }; for (const listener of sessionListeners) listener() },
    dispose: unmount,
  }
}

test('welcome shadows the conversation only for a blank session inside the Nodo space', () => {
  const sessions = { blank: { blank: true }, started: { blank: false } }
  const h = harness(sessions)
  h.open('blank')
  assert.equal(h.registrations.length, 0, 'the ordinary space keeps the native conversation')
  h.enter()
  assert.equal(h.registrations.length, 1)
  assert.equal(h.registrations[0].options.name, 'main.conversation')
  assert.equal(h.registrations[0].options.priority, -100)
  h.open('started')
  assert.equal(h.registrations.length, 0, 'a non-blank session restores the native entry')
  h.open('blank')
  assert.equal(h.registrations.length, 1, 'returning to a blank session re-registers')
  h.dispose()
  assert.equal(h.registrations.length, 0)
})

test('the first sent message hands the area back to the host flow', () => {
  const sessions = { 'nodo-1': { blank: true } }
  const h = harness(sessions)
  h.open('nodo-1')
  h.enter()
  assert.equal(h.registrations.length, 1)
  h.send('nodo-1')
  assert.equal(h.registrations.length, 0, 'the blank flip alone must release the welcome')
  h.dispose()
})

test('leaving the space or entering legacy mode restores the native conversation', () => {
  const sessions = { 'nodo-1': { blank: true } }
  const h = harness(sessions)
  h.open('nodo-1')
  h.enter()
  assert.equal(h.registrations.length, 1)
  h.leave()
  assert.equal(h.registrations.length, 0)
  h.enter()
  assert.equal(h.registrations.length, 1)
  h.goLegacy()
  assert.equal(h.registrations.length, 0, 'the legacy main panel must not carry the welcome')
  h.dispose()
})

test('an open draft hides the welcome and a merely kept one does not', () => {
  const sessions = { 'nodo-1': { blank: true } }
  const h = harness(sessions)
  h.open('nodo-1')
  h.enter()
  h.draft(true)
  assert.equal(h.registrations.length, 0)
  h.draft(false)
  assert.equal(h.registrations.length, 1, 'a draft kept for its rail row must not hide the blank session welcome')
  h.dispose()
})
