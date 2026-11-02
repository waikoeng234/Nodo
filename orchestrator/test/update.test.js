import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { boot } from './helpers/host.js'
import { checkRelease, install } from '../src/host/update.js'
import { isNewer } from '../core/shared/version.js'

const release = tag => ({ tag_name: tag, published_at: '2026-11-01T00:00:00Z', body: '### 修复\n- 稳定性',
  html_url: `https://github.com/waikoeng234/Nodo/releases/tag/${tag}` })
const answer = body => ({ ok: true, json: async () => body })

test('a release counts only when its version is strictly higher', () => {
  assert.equal(isNewer('0.1.0', 'v0.2.0'), true)
  assert.equal(isNewer('0.1.0', '0.1.1'), true)
  assert.equal(isNewer('0.9.0', 'v1.0.0'), true)
  assert.equal(isNewer('0.2.10', 'v0.3.0'), true)
  assert.equal(isNewer('0.1.0', 'v0.1.0'), false)
  assert.equal(isNewer('0.1.0', 'v0.0.9'), false)
  assert.equal(isNewer('0.1.0', ''), false)
  assert.equal(isNewer('0.1.0', undefined), false)
  for (const version of ['v0.2.bad', 'v0.2', 'v0.2.0-beta', 'v0.2.0.1', 'release-0.2.0'])
    assert.equal(isNewer('0.1.0', version), false, version)
})

test('the check maps the GitHub fields and strips the v prefix', async () => {
  const info = await checkRelease(async url => {
    assert.equal(url, 'https://api.github.com/repos/waikoeng234/Nodo/releases/latest')
    return answer(release('v0.2.0'))
  }, '0.1.0', true)
  assert.deepEqual(info, { current: '0.1.0', latest: '0.2.0', publishedAt: '2026-11-01T00:00:00Z',
    notes: '### 修复\n- 稳定性', url: 'https://github.com/waikoeng234/Nodo/releases/tag/v0.2.0', source: true })
})

test('local prerelease and build suffixes compare numerically while remote tags stay strict', async () => {
  for (const current of ['0.1.0-rc.1', 'v0.1.0+local', '0.1.0-rc.1+local']) {
    assert.equal(isNewer(current, 'v0.2.0'), true)
    assert.equal(isNewer(current, 'v0.1.0'), false)
    assert.equal(isNewer(current, 'v0.0.9'), false)
    assert.equal(isNewer(current, 'v0.2.0-rc.1'), false)
    assert.equal(isNewer(current, 'v0.2.0+local'), false)
    assert.equal((await checkRelease(async () => answer(release('v0.2.0')), current, true)).latest, '0.2.0')
  }
})

test('release URLs accept only the https GitHub prefix', async () => {
  for (const url of ['https://github.com/waikoeng234/Nodo/releases/tag/v0.2.0', '', null, 123,
    'http://github.com/waikoeng234/Nodo', 'https://github.com.evil.test/release', 'https://example.com/', 'javascript:alert(1)']) {
    const info = await checkRelease(async () => answer({ ...release('v0.2.0'), html_url: url }), '0.1.0', true)
    assert.equal(info.url, typeof url === 'string' && url.startsWith('https://github.com/') ? url : '')
  }
})

test('a lower or equal latest release is no update', async () => {
  assert.equal(await checkRelease(async () => answer(release('v0.1.0')), '0.1.0', false), null)
  assert.equal(await checkRelease(async () => answer(release('v0.0.9')), '0.1.0', false), null)
})

test('request failures of every kind read as no update', async () => {
  assert.equal(await checkRelease(async () => ({ ok: false }), '0.1.0', false), null)
  assert.equal(await checkRelease(async () => { throw new Error('offline') }, '0.1.0', false), null)
  assert.equal(await checkRelease(async () => ({ ok: true, json: async () => { throw new Error('broken') } }), '0.1.0', false), null)
  assert.equal(await checkRelease(async () => answer(release('v0.2.bad')), '0.1.0', false), null)
  const sparse = await checkRelease(async () => answer({ tag_name: 'v0.2.0', published_at: null }), '0.1.0', false)
  assert.equal(sparse.latest, '0.2.0')
  assert.equal(sparse.publishedAt, null)
  assert.equal(sparse.notes, '')
  assert.equal(sparse.url, '')
})

test('update-info caches failed checks for thirty minutes, then retries', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 1) })
  const fetch = t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 404 }))
  const rt = { handle: async endpoint => ({ ok: true, value: endpoint }) }
  install(rt)
  assert.equal((await rt.handle('update-info')).value, null)
  t.mock.timers.tick(30 * 60 * 1000 - 1)
  assert.equal((await rt.handle('update-info')).value, null)
  assert.equal(fetch.mock.callCount(), 1)
  fetch.mock.mockImplementation(async () => answer(release('v999.0.0')))
  t.mock.timers.tick(1)
  assert.equal((await rt.handle('update-info')).value.latest, '999.0.0')
  assert.equal(fetch.mock.callCount(), 2)
  assert.equal((await rt.handle('state')).value, 'state')
})

test('successful checks, including no newer release, stay cached for six hours', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 1) })
  const fetch = t.mock.method(globalThis, 'fetch', async () => answer(release('v0.0.0')))
  const rt = { handle() {} }
  install(rt)
  assert.equal((await rt.handle('update-info')).value, null)
  t.mock.timers.tick(6 * 60 * 60 * 1000 - 1)
  assert.equal((await rt.handle('update-info')).value, null)
  assert.equal(fetch.mock.callCount(), 1)
  fetch.mock.mockImplementation(async () => answer(release('v999.0.0')))
  t.mock.timers.tick(1)
  assert.equal((await rt.handle('update-info')).value.latest, '999.0.0')
  t.mock.timers.tick(6 * 60 * 60 * 1000 - 1)
  assert.equal((await rt.handle('update-info')).value.latest, '999.0.0')
  assert.equal(fetch.mock.callCount(), 2)
  t.mock.timers.tick(1)
  await rt.handle('update-info')
  assert.equal(fetch.mock.callCount(), 3)
})

test('concurrent update requests share one in-flight fetch', async t => {
  let resolve
  const fetch = t.mock.method(globalThis, 'fetch', () => new Promise(done => { resolve = done }))
  const rt = { handle() {} }
  install(rt)
  const first = rt.handle('update-info'), second = rt.handle('update-info')
  assert.equal(fetch.mock.callCount(), 1)
  resolve(answer(release('v999.0.0')))
  assert.deepEqual(await first, await second)
  assert.equal(fetch.mock.callCount(), 1)
})

test('source installation detection works with and without .git in an isolated fixture', async t => {
  const root = mkdtempSync(join(tmpdir(), 'nodo-update-source-'))
  const plugin = join(root, 'orchestrator')
  mkdirSync(join(plugin, 'src/host'), { recursive: true })
  mkdirSync(join(plugin, 'core/shared'), { recursive: true })
  for (const file of ['src/host/update.js', 'core/shared/version.js'])
    copyFileSync(join(import.meta.dirname, '..', file), join(plugin, file))
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ type: 'module', version: '0.1.0-rc.1' }))
  t.mock.method(globalThis, 'fetch', async () => answer(release('v0.2.0')))
  try {
    const { install } = await import(pathToFileURL(join(plugin, 'src/host/update.js')))
    for (const source of [false, true]) {
      if (source) mkdirSync(join(root, '.git'))
      const rt = { handle() {} }
      install(rt)
      const info = (await rt.handle('update-info')).value
      assert.equal(info.source, source)
      assert.equal(info.current, '0.1.0-rc.1')
      assert.equal(info.latest, '0.2.0')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('update-info checks GitHub once and serves the cache afterwards', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nodo-update-'))
  const current = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')).version
  const calls = []
  const fetch = globalThis.fetch
  globalThis.fetch = async url => { calls.push(String(url)); return answer(release('v999.0.0')) }
  const host = boot(home)
  try {
    const first = await host.api('update-info')
    const second = await host.api('update-info')
    assert.equal(calls.length, 1)
    assert.equal(calls[0], 'https://api.github.com/repos/waikoeng234/Nodo/releases/latest')
    assert.deepEqual(second, first)
    assert.equal(first.current, current)
    assert.equal(first.latest, '999.0.0')
    assert.equal(first.source, existsSync(join(import.meta.dirname, '../../.git')))
  } finally {
    await host.dispose()
    globalThis.fetch = fetch
    rmSync(home, { recursive: true, force: true })
  }
})
