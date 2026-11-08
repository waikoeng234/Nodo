import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRemoteAccess, proxyTarget } from '../remote-access/index.js'
import { command } from '../remote-access/command.js'

const origin = 'https://fixture.tail0000.ts.net'
const key = 'fixture.tail0000.ts.net:443'
const json = value => ({ code: 0, stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.alloc(0) })

function fixture(options = {}) {
  let prefs = options.prefs ?? {}, config = options.config ?? {}, running = 0, status = options.status ?? {
    BackendState: 'Running', Self: { DNSName: 'fixture.tail0000.ts.net.', Online: true }, Health: [],
  }
  const calls = []
  const service = createRemoteAccess({
    host: { getOrigin: () => 'http://127.0.0.1:12345' },
    connection: { authenticatedUrl: value => `${value}/?token=fixture-only` },
    preferences: () => prefs, save: async value => { prefs = value }, platform: options.platform ?? 'darwin',
    exists: () => !options.missing,
    proxy: async () => { if (options.proxyError) throw new Error('occupied'); running++; return () => { running-- } },
    run: async (file, args, input) => {
      calls.push({ file, args, input })
      if (args[0] === 'status') return json(status)
      if (args[0] === 'serve' && args[1] === 'status') return json(config)
      if (args[0] === 'serve' && args.includes('off')) {
        delete config.Web[key].Handlers['/']; return { code: 0 }
      }
      if (args[0] === 'serve') {
        if (options.authorize) return { code: 'ETIMEDOUT', stdout: '', stderr: 'https://login.tailscale.com/f/serve?node=fixture' }
        config = { ...config, Web: { ...config.Web, [key]: { Handlers: { '/': { Proxy: proxyTarget } } } } }
        return { code: 0 }
      }
      if (file.endsWith('osascript')) return { code: 0, stdout: Buffer.from([137,80,78,71,13,10,26,10,0]) }
      return { code: 0 }
    },
  })
  return { service, calls, preferences: () => prefs, running: () => running, config: () => config,
    setStatus: value => { status = value } }
}

test('environment stages do not start services or expose login credentials', async () => {
  for (const [options, phase] of [
    [{ platform: 'win32' }, 'unsupported'], [{ missing: true }, 'unsupported'],
    [{ status: { BackendState: 'NeedsLogin' } }, 'connect'],
    [{ status: { BackendState: 'Running', Health: ['ReceiveIPv4 is not running'] } }, 'network'],
    [{}, 'ready'],
  ]) {
    const f = fixture(options)
    const value = await f.service.status()
    assert.equal(value.phase, phase)
    assert(!JSON.stringify(value).includes('fixture-only'))
    assert.equal(f.running(), 0)
  }
})

test('enable discovers the domain and persists only non-secret preferences', async () => {
  const f = fixture()
  assert.equal((await f.service.enable()).phase, 'enabled')
  assert.deepEqual(f.preferences(), { enabled: true, origin })
  assert.equal(f.running(), 1)
  const args = f.calls.find(c => c.args.includes(proxyTarget)).args
  assert(args.includes('--set-path=/'))
  assert(args.includes('--bg'))
  const login = await f.service.login()
  assert.equal(login.url, `${origin}/?token=fixture-only`)
  const qr = f.calls.find(c => c.file.endsWith('osascript'))
  assert.equal(qr.input.input, login.url)
  assert(!qr.args.join(' ').includes('fixture-only'))
  assert(!(await f.service.status()).url)
  await f.service.close()
  assert.equal(f.running(), 0)
  assert.equal(f.preferences().enabled, true)
})

test('HTTPS authorization is surfaced without keeping an unused proxy', async () => {
  const f = fixture({ authorize: true })
  const result = await f.service.enable()
  assert.equal(result.phase, 'authorize')
  assert.equal(result.authorizationUrl, 'https://login.tailscale.com/f/serve?node=fixture')
  assert.equal(f.running(), 0)
  assert.equal(f.preferences().enabled, undefined)
})

test('foreign forwarding and public Funnel are left untouched', async () => {
  for (const config of [
    { Web: { [key]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } },
    { AllowFunnel: { [key]: true } }, { TCP: { 443: { TCPForward: '127.0.0.1:1234' } } },
  ]) {
    const f = fixture({ config })
    assert.equal((await f.service.enable()).phase, 'conflict')
    assert.equal(f.running(), 0)
    assert(!f.calls.some(c => c.args.includes('--bg')))
  }
})

test('disable removes only its matching root handler and leaves other paths', async () => {
  const config = { Web: { [key]: { Handlers: { '/': { Proxy: proxyTarget }, '/other': { Proxy: 'http://127.0.0.1:9999' } } } } }
  const f = fixture({ prefs: { enabled: true, origin }, config })
  await f.service.resume()
  assert.equal(f.running(), 1)
  await f.service.disable()
  assert.deepEqual(f.preferences(), { enabled: false })
  assert.equal(f.running(), 0)
  assert.equal(f.config().Web[key].Handlers['/'], undefined)
  assert(f.config().Web[key].Handlers['/other'])
  assert(f.calls.find(c => c.args.includes('off')).args.includes('--set-path=/'))
})

test('disable never removes a replacement installed by another service', async () => {
  const f = fixture({ prefs: { enabled: true, origin }, config: { Web: { [key]: { Handlers: { '/': { Text: 'other' } } } } } })
  await f.service.disable()
  assert(!f.calls.some(c => c.args.includes('off')))
  assert.equal(f.config().Web[key].Handlers['/'].Text, 'other')
})

test('resume restores the proxy without rewriting Serve or issuing a login link', async () => {
  const f = fixture({ prefs: { enabled: true, origin }, config: { Web: { [key]: { Handlers: { '/': { Proxy: proxyTarget } } } } } })
  await f.service.resume()
  assert.equal((await f.service.status()).phase, 'enabled')
  assert(!f.calls.some(c => c.args.includes('--bg')))
  await f.service.close()
})

test('a stopped setup cannot start a proxy or produce login credentials', async () => {
  const f = fixture()
  await f.service.close()
  await assert.rejects(f.service.enable(), /停止/)
  await assert.rejects(f.service.login(), /启用/)
  assert.equal(f.running(), 0)
})

test('macOS generates an actual QR PNG using the system encoder', { skip: process.platform !== 'darwin' }, async () => {
  const result = await command('/usr/bin/osascript', ['-l', 'JavaScript', new URL('../remote-access/qr-code.jxa', import.meta.url).pathname],
    { input: 'https://fixture.tail0000.ts.net/?fixture=1' })
  assert.equal(result.code, 0)
  assert(Buffer.from(result.stdout).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
})
