// The shared dshDesktop.updates bridge: one dsh subscription for any number of
// stream consumers, pause on `installing`, resume on any other phase, and no
// listener left behind after the last consumer unsubscribes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const desktop = () => {
  const listeners = new Set()
  return {
    dshDesktop: { updates: { subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) } } },
    emit: phase => { for (const listener of [...listeners]) listener({ phase }) },
    count: () => listeners.size,
  }
}

test('installing pauses every consumer, other phases resume them, and the last unsubscribe releases dsh', async () => {
  const env = desktop()
  const events = []
  const { subscribeUpdatePause, updateInstalling } = await loadClient('dsh-updates.js', { globals: env })
  const stopA = subscribeUpdatePause(() => events.push('pause-a'), () => events.push('resume-a'))
  const stopB = subscribeUpdatePause(() => events.push('pause-b'), () => events.push('resume-b'))
  assert.equal(updateInstalling(), false)
  assert.equal(env.count(), 1, 'both consumers share one dshDesktop.updates subscription')
  env.emit('downloading')
  assert.deepEqual(events, [])
  env.emit('installing')
  assert.deepEqual(events, ['pause-a', 'pause-b'])
  assert.equal(updateInstalling(), true)
  env.emit('ready')
  assert.deepEqual(events, ['pause-a', 'pause-b', 'resume-a', 'resume-b'])
  assert.equal(updateInstalling(), false)
  stopA()
  assert.equal(env.count(), 1, 'a consumer leaving keeps the subscription for the rest')
  stopB()
  assert.equal(env.count(), 0, 'the last consumer unsubscribes from dshDesktop.updates')
  env.emit('installing')
  assert.equal(events.length, 4, 'events after unsubscribing reach nobody')
  assert.equal(updateInstalling(), false)
})

test('a consumer joining mid-install starts paused and an environment without dshDesktop.updates stays inert', async () => {
  const env = desktop()
  const paused = []
  const first = await loadClient('dsh-updates.js', { globals: env })
  const stopA = first.subscribeUpdatePause(() => paused.push('a'), () => {})
  env.emit('installing')
  assert.deepEqual(paused, ['a'])
  const stopB = first.subscribeUpdatePause(() => paused.push('b'), () => {})
  assert.deepEqual(paused, ['a', 'b'], 'a consumer joining mid-install starts paused')
  env.emit('idle')
  stopA(); stopB()
  const plain = await loadClient('dsh-updates.js', {})
  const stop = plain.subscribeUpdatePause(() => { throw new Error('must not pause') }, () => { throw new Error('must not resume') })
  assert.equal(plain.updateInstalling(), false, 'no dshDesktop.updates means never installing')
  stop()
})
