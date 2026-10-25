import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

test('a scrollbar shows while its own element scrolls and fades after it rests', async () => {
  const timers = new Map()
  let serial = 0
  const { installScrollbars, SCROLLBAR_CSS } = await loadClient('scrollbars.ts', { globals: {
    setTimeout: (callback, ms) => { timers.set(++serial, { callback, ms }); return serial },
    clearTimeout: id => timers.delete(id),
  } })
  const listeners = []
  const document = {
    addEventListener: (type, listener, options) => listeners.push({ type, listener, options }),
    removeEventListener: (type, listener) => listeners.splice(listeners.findIndex(item => item.listener === listener), 1),
  }
  const element = (inside = true) => {
    const attributes = new Set()
    return { attributes, closest: () => inside ? {} : null, setAttribute: name => attributes.add(name), removeAttribute: name => attributes.delete(name) }
  }
  const dispose = installScrollbars(document)
  assert.equal(listeners[0].type, 'scroll')
  assert.equal(listeners[0].options.capture, true, 'scroll does not bubble, so one captured listener sees every scroller')
  const list = element(), host = element(false)
  const scroll = target => listeners[0].listener({ target })
  scroll(list); scroll(host)
  assert.ok(list.attributes.has('data-scrolling'))
  assert.equal(host.attributes.size, 0, 'elements outside Nodo stay untouched')
  scroll(list)
  assert.equal(timers.size, 1, 'each new scroll restarts the idle wait')
  for (const { callback } of timers.values()) callback()
  assert.equal(list.attributes.has('data-scrolling'), false)
  scroll(list)
  dispose()
  assert.equal(listeners.length, 0)
  assert.equal(list.attributes.size, 0, 'disposing rests every scroller')
  assert.equal(/(#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\()/i.test(SCROLLBAR_CSS), false, 'the thumb keeps the host colour')
})

test('document scroll events target the root scroller only while the Nodo space is active', async () => {
  let listener, idle
  const { installScrollbars, SCROLLBAR_CSS } = await loadClient('scrollbars.ts', { globals: {
    setTimeout: callback => { idle = callback; return 1 }, clearTimeout() {},
  } })
  let active = true
  const attributes = new Set()
  const root = { closest: () => active ? root : null,
    setAttribute: name => attributes.add(name), removeAttribute: name => attributes.delete(name) }
  const document = { scrollingElement: root, addEventListener: (_type, callback) => { listener = callback }, removeEventListener() {} }
  const dispose = installScrollbars(document)
  listener({ target: document })
  assert.equal(attributes.has('data-scrolling'), true)
  idle()
  assert.equal(attributes.size, 0)
  active = false
  listener({ target: document })
  assert.equal(attributes.size, 0)
  dispose()
  assert.match(SCROLLBAR_CSS, /:where\(:root\[data-nodo-space\],\.nodo-page\)\[data-scrolling\]/)
  assert.match(SCROLLBAR_CSS, /:is\(:root\[data-nodo-space\],\.nodo-page\)::-webkit-scrollbar-thumb/)
})
