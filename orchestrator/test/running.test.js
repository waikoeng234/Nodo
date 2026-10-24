import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadClient } from './helpers/client-module.js'

const templates = JSON.parse(readFileSync(new URL('../core/shared/avatar-templates.json', import.meta.url), 'utf8'))

async function mount(start = 0, reduce = false) {
  const hooks = [], pending = [], timers = new Map(), listeners = new Set()
  let cursor = 0, now = start, serial = 0
  const media = { matches: reduce, addEventListener: (_, run) => listeners.add(run), removeEventListener: (_, run) => listeners.delete(run) }
  const { RunningLine } = await loadClient('running.js', {
    stubs: { 'avatar.tsx': { RoleAvatar: 'RoleAvatar' } },
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(child => child !== false) }),
    react: {
      useRef(initial) { return hooks[cursor++] ??= { current: initial } },
      useState(initial) {
        const index = cursor++
        hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial }
        return [hooks[index].value, value => { hooks[index].value = value }]
      },
      useEffect(effect, deps) {
        const index = cursor++, previous = hooks[index]
        if (previous && deps.every((value, at) => value === previous.deps[at])) return
        pending.push(() => { previous?.cleanup?.(); hooks[index] = { deps, cleanup: effect() } })
      },
    },
    globals: {
      Date: { now: () => now },
      setInterval(run) { timers.set(++serial, run); return serial },
      clearInterval: id => timers.delete(id), window: { matchMedia: () => media },
    },
  })
  return {
    render(since, engine) {
      cursor = 0
      const tree = RunningLine({ since, engine })
      pending.splice(0).forEach(run => run())
      return tree
    },
    tick(at) { now = at; timers.forEach(run => run()) },
    motion(value) { media.matches = value; listeners.forEach(run => run()) },
    dispose() { hooks.forEach(hook => hook.cleanup?.()) },
    timers, listeners,
  }
}

const all = tree => typeof tree === 'object' && tree !== null ? [tree, ...tree.children.flatMap(all)] : []
const elapsedLabel = tree => all(tree).find(node => node.props['aria-label']?.startsWith('用时 '))?.props['aria-label']

test('engine silence uses the last received event clock and clears when new activity arrives', async () => {
  const view = await mount(1000)
  const statusLabel = tree => all(tree).find(node => node.props.className === 'nodo-running-label').props['aria-label']
  const engine = { phase: 'tool', tool: 'read', lastEventAt: 1000 }
  view.render(0, engine)
  view.tick(31000)
  assert.equal(statusLabel(view.render(0, engine)), '正在执行 read · 30s 未收到新事件')
  view.tick(301000)
  assert.equal(statusLabel(view.render(0, engine)), '正在执行 read · 5m 0s 未收到新事件')
  assert.equal(statusLabel(view.render(0, { phase: 'thinking', lastEventAt: 301000 })), '正在思考')
  assert.equal(elapsedLabel(view.render(0, engine)), '用时 5m 1s')
  view.dispose()
})

test('running status follows the six avatar colors forward and backward on the elapsed clock', async () => {
  const view = await mount()
  view.render(0)
  const expected = ['sky', 'peach', 'olive', 'mint', 'lavender', 'butter', 'lavender', 'mint', 'olive', 'peach', 'sky']
  expected.forEach((id, index) => {
    view.tick(index * 3160)
    const tree = view.render(0)
    assert.equal(tree.props.style['--nodo-running-tint'], templates.find(template => template.id === id).color)
    assert.equal(tree.props.style['--nodo-running-phase'], '0ms', 'clock ticks do not restart the motion phase')
    assert.equal(elapsedLabel(tree), `用时 ${Math.floor(index * 3.16)}s`)
  })
  view.tick(3661000)
  assert.equal(elapsedLabel(view.render(0)), '用时 1h 1m 1s')
  view.dispose()
})

test('reduced motion freezes the palette and its subscription and clock are cleaned up', async () => {
  const view = await mount(6320, true)
  view.render(0)
  assert.equal(view.render(0).props.style['--nodo-running-tint'], templates[0].color)
  view.motion(false)
  assert.equal(view.render(0).props.style['--nodo-running-tint'], templates[2].color)
  view.motion(true)
  view.tick(12640)
  assert.equal(view.render(0).props.style['--nodo-running-tint'], templates[0].color)
  assert.equal(elapsedLabel(view.render(0)), '用时 12s', 'the elapsed clock still updates without motion')
  assert.equal(view.timers.size, 1)
  assert.equal(view.listeners.size, 1)
  view.dispose()
  assert.equal(view.timers.size, 0)
  assert.equal(view.listeners.size, 0)
})

test('missing and future start times stay valid and a new turn replaces the previous clock', async () => {
  const view = await mount(5000)
  assert.equal(elapsedLabel(view.render(undefined)), undefined)
  view.tick(8160)
  assert.equal(view.render(undefined).props.style['--nodo-running-tint'], templates[1].color)
  let tree = view.render(9000)
  assert.equal(elapsedLabel(tree), '用时 0s')
  assert.equal(tree.props.style['--nodo-running-tint'], templates[0].color)
  view.tick(15320)
  tree = view.render(9000)
  assert.equal(elapsedLabel(tree), '用时 6s')
  assert.equal(tree.props.style['--nodo-running-tint'], templates[2].color)
  assert.equal(view.timers.size, 1)
  view.dispose()
})
