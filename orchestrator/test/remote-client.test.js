import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadClient } from './helpers/client-module.js'

const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...(tree.children ?? []).flatMap(nodes)]
const text = tree => nodes(tree).flatMap(node => node.children ?? []).filter(value => typeof value === 'string').join('')
const tick = () => new Promise(resolve => setImmediate(resolve))

async function fixture({ phase = 'ready', readOnly = false, copy = true } = {}) {
  const requests = [], copied = []
  const loaded = await loadClient('remote-access.js', {
    call: async endpoint => {
      requests.push(endpoint)
      if (endpoint === 'remote-enable') {
        if (phase === 'ready') { phase = 'authorize'; return { phase, authorizationUrl: 'https://login.tailscale.com/f/serve?node=fixture' } }
        phase = 'enabled'
      }
      if (endpoint === 'remote-disable') phase = 'ready'
      if (endpoint === 'remote-login') return { url: 'https://fixture.tail0000.ts.net/?fixture=1', qr: 'data:image/png;base64,fixture' }
      return { phase, enabled: phase === 'enabled', origin: 'https://fixture.tail0000.ts.net' }
    },
    primitives: { writeClipboard: async value => { copied.push(value); return copy } },
  })
  const render = () => { loaded.host.reset(); return loaded.RemoteAccessSettings({ readOnly }) }
  const button = label => nodes(render()).find(node => node.type === 'Button' && text(node) === label)
  render()
  loaded.host.effects.shift()()
  await tick()
  const click = async label => { button(label).props.onClick(); await tick() }
  return { render, button, click, requests, copied }
}

test('phone setup completes authorization before offering a fresh login and removes the link when disabled', async () => {
  const f = await fixture()
  assert.deepEqual(f.requests, ['remote-status'])
  await f.click('启用手机远程')
  const auth = nodes(f.render()).find(node => node.type === 'a')
  assert.equal(auth.props.href, 'https://login.tailscale.com/f/serve?node=fixture')
  assert(!f.button('连接手机'))
  await f.click('已授权，继续配置')
  assert(!nodes(f.render()).some(node => node.type === 'img'), 'login is generated only on request')
  await f.click('连接手机')
  assert(nodes(f.render()).some(node => node.type === 'img' && node.props.alt === '手机登录二维码'))
  assert(text(f.render()).includes('请勿分享'))
  assert(!text(f.render()).includes('扫描二维码'))
  await f.click('复制手机登录链接')
  assert.deepEqual(f.copied, ['https://fixture.tail0000.ts.net/?fixture=1'])
  assert(f.button('已复制'))
  await f.click('关闭远程访问')
  assert(!nodes(f.render()).some(node => node.type === 'img'))
  assert(!f.button('复制手机登录链接'))
})

test('settings show only heading, status and actions without a generic setup guide', async () => {
  for (const phase of ['ready', 'conflict', 'unavailable']) {
    const f = await fixture({ phase })
    const shown = text(f.render())
    for (const guide of ['从手机浏览器', '登录同一账号', 'Android']) assert(!shown.includes(guide), `${phase}: ${guide}`)
  }
})

test('read-only settings keep status available and prevent connection changes and login generation', async () => {
  const f = await fixture({ phase: 'enabled', readOnly: true })
  assert.equal(f.button('连接手机').props.disabled, true)
  assert.equal(f.button('关闭远程访问').props.disabled, true)
  assert.equal(f.button('重新检查').props.disabled, false)
  assert.deepEqual(f.requests, ['remote-status'])
})

test('a rejected clipboard write does not claim that the login link was copied', async () => {
  const f = await fixture({ phase: 'enabled', copy: false })
  await f.click('连接手机')
  await f.click('复制手机登录链接')
  assert(!f.button('已复制'))
  assert(nodes(f.render()).some(node => node.props.role === 'alert' && text(node).includes('复制失败')))
})

test('the existing settings dialog exposes phone access as a keyboard-selectable tab', async () => {
  const { EngineSettingsDialog, RemoteAccessSettings, host } = await loadClient(['engine-settings.js', 'remote-access.js'])
  const render = () => { host.reset(); return EngineSettingsDialog({ view: { prefs: {} }, readOnly: true }) }
  const tabs = () => nodes(render()).filter(node => node.props.role === 'tab')
  assert.equal(tabs()[0].props.tabIndex, 0)
  let focused, prevented = false
  tabs()[0].props.onKeyDown({ key: 'ArrowRight', preventDefault: () => { prevented = true },
    currentTarget: { parentElement: { querySelector: selector => ({ focus: () => { focused = selector } }) } } })
  assert(prevented)
  assert.equal(focused, '#nodo-settings-remote')
  assert.equal(tabs()[1].props['aria-selected'], true)
  const panel = nodes(render()).find(node => node.props.role === 'tabpanel')
  assert.equal(panel.props['aria-labelledby'], tabs()[1].props.id)
  assert.equal(nodes(panel).find(node => node.type === RemoteAccessSettings).props.readOnly, true)
  assert.equal(render().props.footer, undefined)
})
