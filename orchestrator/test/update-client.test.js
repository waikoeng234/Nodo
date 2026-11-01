import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : !('type' in node) || !('props' in node) ? []
  : [node, ...Object.entries(node.props ?? {}).filter(([key]) => key !== 'children').flatMap(([, value]) => nodes(value)), ...(node.children ?? []).flatMap(nodes)]
const text = node => nodes(node).flatMap(item => item.children ?? []).filter(child => typeof child === 'string').join('')
const tick = () => new Promise(resolve => setImmediate(resolve))

const workspace = { id: 'w', name: 'Project', cwd: '/p', createdAt: 1 }
const view = { workspaces: [workspace], work: {}, profiles: [
  { id: 'coder', name: 'Coder', sessions: [{ id: 's1', name: 'Fix login', workspaceRef: 'w', updatedAt: 1 }] },
] }
const info = latest => ({ current: '0.1.0', latest, publishedAt: '2026-11-01T00:00:00Z',
  notes: '### 修复\n- 稳定性', url: `https://github.com/waikoeng234/Nodo/releases/tag/v${latest}`, source: true })

async function railWith({ latest, stored = null } = {}) {
  const slots = []
  const timers = new Map(), cleanups = [], requests = []
  let cursor = 0
  const skip = { stored }
  const { Rail, UpdateCard, host } = await loadClient(['session-rail.tsx', 'avatar.tsx', 'ui-shared.js'], {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children },
      children: children.flat(Infinity).filter(child => child !== false && child !== null && child !== undefined) }),
    primitives: { relativeTime: () => ({ unit: 'now', n: 0 }) },
    globals: {
      window: { addEventListener() {}, removeEventListener() {}, open() {} },
      localStorage: { getItem: () => skip.stored, setItem: (_key, value) => { skip.stored = value } },
      setInterval: (callback, ms) => { const timer = {}; timers.set(timer, { callback, ms }); return timer },
      clearInterval: timer => timers.delete(timer),
    },
    react: { useState: initial => {
      const slot = cursor++
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
      return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value }]
    } },
    call: endpoint => { requests.push(endpoint); return endpoint === 'update-info' ? latest ? info(latest) : null : undefined },
  })
  const render = () => {
    cursor = 0
    const tree = nodes(Rail({ view, workspace, sessionId: 's1', onSelect() {}, onSelectSession() {} }))
    return tree.flatMap(node => node.type === UpdateCard ? nodes(UpdateCard(node.props)) : [node])
  }
  const flush = async () => { for (const effect of host.effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup) } await tick() }
  return { render, flush, skip, timers, requests, setLatest: value => { latest = value },
    dispose: () => { for (const cleanup of cleanups) cleanup() } }
}

const dockButton = render => render().find(node => node.type === 'button' && String(node.props['aria-label'] ?? '').startsWith('新版本 v'))
const card = render => render().find(node => node.props.role === 'dialog' && node.props['aria-label'] === 'Nodo 有新版本')
const quiet = (render, label) => render().filter(node => node.props.className === 'nodo-update-quiet').find(node => text(node) === label)

test('a newer release shows the dotted dock button and its card, and 稍后 keeps the button', async () => {
  const { render, flush } = await railWith({ latest: '0.2.0' })
  render()
  await flush()
  const button = dockButton(render)
  assert.equal(button.props['aria-label'], '新版本 v0.2.0')
  assert.equal(button.props['aria-haspopup'], 'menu')
  assert.equal(nodes(button).find(node => node.type === 'IconDownloadOutlineRegular').props.size, 16)
  assert.equal(nodes(button).some(node => node.type === 'i' && node.props.className === 'nodo-update-dot'), true, 'the accent dot rides the icon')
  assert.equal(card(render), undefined, 'the card waits behind the dock button')
  button.props.onClick()
  assert.equal(dockButton(render).props['aria-expanded'], true)
  const menu = render().find(node => node.type === 'Menu' && node.props.className === 'nodo-update')
  assert.equal(menu.props.portal, true, 'the host portal escapes the sidebar clipping')
  assert.equal(menu.props.side, 'right')
  assert.equal(text(card(render)).includes(`v0.1.0 → v0.2.0 · ${new Date(info('0.2.0').publishedAt).toLocaleDateString('sv-SE')}`), true)
  assert.equal(nodes(card(render)).some(node => node.type === 'code' && node.props.children === 'git pull && npm ci --ignore-scripts && npm run build:check'),
    true, 'a source install offers the update command')
  quiet(render, '稍后').props.onClick()
  assert.equal(card(render), undefined, '稍后 closes the card')
  assert.equal(dockButton(render).props['aria-label'], '新版本 v0.2.0', 'the button survives 稍后')
  dockButton(render).props.onClick()
  menu.props.onClose()
  assert.equal(card(render), undefined, 'host dismissal closes the card')
})

test('跳过此版本 remembers the version and hides the notice; a higher one shows it again', async () => {
  const first = await railWith({ latest: '0.2.0' })
  first.render()
  await first.flush()
  dockButton(first.render).props.onClick()
  quiet(first.render, '跳过此版本').props.onClick()
  assert.equal(first.skip.stored, '0.2.0')
  assert.equal(dockButton(first.render), undefined, 'the skipped version hides its button')

  const higher = await railWith({ latest: '0.3.0', stored: '0.2.0' })
  higher.render()
  await higher.flush()
  assert.equal(dockButton(higher.render).props['aria-label'], '新版本 v0.3.0', 'a higher version shows the notice again')

  const same = await railWith({ latest: '0.2.0', stored: '0.2.0' })
  same.render()
  await same.flush()
  assert.equal(dockButton(same.render), undefined, 'an equal version stays hidden')
})

test('no update means no dock button', async () => {
  const { render, flush } = await railWith({})
  render()
  await flush()
  assert.equal(dockButton(render), undefined)
})

test('an empty skipped-version value does not hide the update', async () => {
  const { render, flush } = await railWith({ latest: '0.2.0', stored: '' })
  render()
  await flush()
  assert.equal(dockButton(render).props['aria-label'], '新版本 v0.2.0')
})

test('polling discovers an update after an initial failure and stops after unmount', async () => {
  const rail = await railWith({})
  rail.render()
  await rail.flush()
  assert.equal(dockButton(rail.render), undefined)
  assert.deepEqual(rail.requests, ['update-info'])
  assert.equal(rail.timers.size, 1)
  const timer = [...rail.timers.values()][0]
  assert.equal(timer.ms, 30 * 60 * 1000)
  rail.setLatest('0.2.0')
  timer.callback()
  await tick()
  assert.equal(dockButton(rail.render).props['aria-label'], '新版本 v0.2.0')
  assert.deepEqual(rail.requests, ['update-info', 'update-info'])
  rail.dispose()
  assert.equal(rail.timers.size, 0)
})

test('an empty release URL omits the release-page action', async () => {
  const { UpdateCard } = await loadClient('session-rail.tsx')
  const tree = UpdateCard({ info: { ...info('0.2.0'), url: '' }, onClose() {}, onSkip() {} })
  assert.equal(nodes(tree).some(node => node.type === 'Button'), false)
  assert.equal(text(tree).includes('跳过此版本'), true)
  assert.equal(text(tree).includes('稍后'), true)
})

test('the card uses valid block containers and formats the release date in the local timezone', async t => {
  const originalTimezone = process.env.TZ
  t.after(() => { if (originalTimezone === undefined) delete process.env.TZ; else process.env.TZ = originalTimezone })
  for (const [timezone, date] of [['America/Los_Angeles', '2026-11-01'], ['Asia/Shanghai', '2026-11-02']]) {
    process.env.TZ = timezone
    const { UpdateCard } = await loadClient('session-rail.tsx')
    const tree = UpdateCard({ info: { ...info('0.2.0'), publishedAt: '2026-11-01T23:30:00Z' }, onClose() {}, onSkip() {} })
    assert.equal(tree.type, 'div')
    for (const className of ['nodo-update-command', 'nodo-update-actions'])
      assert.equal(nodes(tree).find(node => node.props.className === className).type, 'div')
    assert.equal(text(tree).includes(`v0.1.0 → v0.2.0 · ${date}`), true, timezone)
  }
})

test('the card renders the complete Markdown and highlights only breaking entries', async () => {
  const marks = []
  const root = { querySelectorAll: () => [
    { textContent: '不兼容：配置格式变更', classList: { toggle: (name, active) => marks.push([name, active]) } },
    { textContent: '修复会话显示', classList: { toggle: (name, active) => marks.push([name, active]) } },
  ] }
  const { UpdateCard, host } = await loadClient('session-rail.tsx', {
    react: { useRef: () => ({ current: root }) },
  })
  const notes = '### 变更\n\n- **不兼容**：配置格式变更\n- 修复会话显示\n\n```sh\necho ok\n\n```'
  const tree = UpdateCard({ info: { ...info('0.2.0'), notes, source: false }, onClose() {}, onSkip() {} })
  for (const effect of host.effects.splice(0)) effect()
  assert.equal(nodes(tree).find(node => node.type === 'MarkdownText').props.text, notes)
  assert.equal(nodes(tree).some(node => node.type === 'code'), false, 'a packaged install has no source command')
  assert.deepEqual(marks, [['nodo-update-breaking', true], ['nodo-update-breaking', false]])
})

test('the source command copies through the host primitive and the release action opens the supplied URL', async () => {
  const copied = [], opened = []
  const { UpdateCard, host } = await loadClient('session-rail.tsx', {
    primitives: { writeClipboard: async value => { copied.push(value); return true } },
    globals: { setTimeout() {}, open: (...args) => opened.push(args) },
  })
  const props = { info: info('0.2.0'), onClose() {}, onSkip() {} }
  const tree = UpdateCard(props)
  const copy = nodes(tree).find(node => node.props.className === 'nodo-update-copy')
  assert.equal(copy.props['aria-label'], '复制')
  assert.equal(copy.props.title, '复制')
  assert.equal(nodes(copy).some(node => node.type === 'IconCopyOutlineRegular'), true, 'the idle button shows the copy glyph')
  await copy.props.onClick()
  assert.deepEqual(copied, ['git pull && npm ci --ignore-scripts && npm run build:check'])
  host.reset()
  const done = nodes(UpdateCard(props)).find(node => node.props.className === 'nodo-update-copy')
  assert.equal(done.props['aria-label'], '已复制')
  assert.equal(done.props.title, '已复制')
  assert.equal(nodes(done).some(node => node.type === 'IconCheckOutlineRegular'), true, 'the copied button shows the check glyph')
  nodes(tree).find(node => node.type === 'Button').props.onClick()
  assert.deepEqual(opened, [[props.info.url, '_blank', 'noopener,noreferrer']])
})
