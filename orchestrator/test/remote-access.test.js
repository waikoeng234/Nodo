import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRemoteAccess } from '../remote-access/index.js'
import { command } from '../remote-access/command.js'

const origin = 'https://fixture.tail0000.ts.net'
const key = 'fixture.tail0000.ts.net:443'
const own = port => `http://127.0.0.1:${port}`
const json = value => ({ code: 0, stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.alloc(0) })

function fixture(options = {}) {
  let prefs = options.prefs ?? {}, config = options.config ?? {}, running = 0, next = 50001, status = options.status ?? {
    BackendState: 'Running', Self: { DNSName: 'fixture.tail0000.ts.net.', Online: true }, Health: [],
  }
  const calls = [], ports = []
  const service = createRemoteAccess({
    host: { getOrigin: () => 'http://127.0.0.1:12345' },
    connection: { authenticatedUrl: value => `${value}/?token=fixture-only` },
    preferences: () => prefs, save: async value => { prefs = value }, platform: options.platform ?? 'darwin',
    exists: () => !options.missing,
    proxy: async (upstream, mobile, port) => {
      ports.push(port)
      if (options.proxyError) throw new Error('occupied')
      running++
      return { port: port ?? next++, stop: () => { running-- } }
    },
    run: async (file, args, input) => {
      calls.push({ file, args, input })
      if (args[0] === 'status') return json(status)
      if (args[0] === 'serve' && args[1] === 'status') return json(config)
      if (args[0] === 'serve' && args.includes('off')) {
        delete config.Web?.[key]?.Handlers['/']; return { code: 0 }
      }
      if (args[0] === 'serve') {
        if (options.authorize) return { code: 'ETIMEDOUT', stdout: '', stderr: 'https://login.tailscale.com/f/serve?node=fixture' }
        config = { ...config, Web: { ...config.Web, [key]: { Handlers: { '/': { Proxy: args.at(-1) } } } } }
        return { code: 0 }
      }
      if (file.endsWith('osascript')) return { code: 0, stdout: Buffer.from([137,80,78,71,13,10,26,10,0]) }
      return { code: 0 }
    },
  })
  return { service, calls, ports, preferences: () => prefs, running: () => running, config: () => config,
    setStatus: value => { status = value } }
}

test('environment stages do not start services or expose login credentials', async () => {
  for (const [options, phase] of [
    [{ platform: 'win32' }, 'unsupported'], [{ missing: true }, 'unsupported'],
    [{ status: { BackendState: 'NeedsLogin' } }, 'connect'],
    [{ status: { BackendState: 'Running', Health: ['ReceiveIPv4 is not running'] } }, 'network'],
    [{ status: { BackendState: 'Running', Self: { DNSName: 'fixture.tail0000.ts.net.' },
      Health: ["Some peers are advertising routes but --accept-routes is false"] } }, 'ready'],
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
  assert.deepEqual(f.preferences(), { enabled: true, origin, port: 50001 })
  assert.equal(f.running(), 1)
  const args = f.calls.find(c => c.args.includes(own(50001))).args
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
  const config = { Web: { [key]: { Handlers: { '/': { Proxy: own(50123) }, '/other': { Proxy: 'http://127.0.0.1:9999' } } } } }
  const f = fixture({ prefs: { enabled: true, origin, port: 50123 }, config })
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

test('resume reuses the persisted port without rewriting Serve or issuing a login link', async () => {
  const f = fixture({ prefs: { enabled: true, origin, port: 50123 }, config: { Web: { [key]: { Handlers: { '/': { Proxy: own(50123) } } } } } })
  await f.service.resume()
  assert.deepEqual(f.ports, [50123])
  assert.equal((await f.service.status()).phase, 'enabled')
  assert(!f.calls.some(c => c.args.includes('--bg') || c.args.includes('off')))
  await f.service.close()
})

test('each enable forwards to a fresh proxy port and persists it', async () => {
  const f = fixture()
  await f.service.enable()
  await f.service.disable()
  assert.deepEqual(f.preferences(), { enabled: false })
  await f.service.enable()
  assert.deepEqual(f.ports, [undefined, undefined])
  assert.deepEqual(f.preferences(), { enabled: true, origin, port: 50002 })
  assert.equal(f.config().Web[key].Handlers['/'].Proxy, own(50002))
})

test('enabling over its own leftover forwarding reuses the persisted port', async () => {
  const f = fixture({ prefs: { enabled: true, origin, port: 50123 }, config: { Web: { [key]: { Handlers: { '/': { Proxy: own(50123) } } } } } })
  assert.equal((await f.service.enable()).phase, 'enabled')
  assert.deepEqual(f.ports, [50123])
  assert(!f.calls.some(c => c.args.includes('--bg')))
  assert.deepEqual(f.preferences(), { enabled: true, origin, port: 50123 })
})

test('preferences saved before ports were persisted still own the former forwarding', async () => {
  const f = fixture({ prefs: { enabled: true, origin }, config: { Web: { [key]: { Handlers: { '/': { Proxy: own(43819) } } } } } })
  await f.service.resume()
  assert.deepEqual(f.ports, [43819])
  assert.equal((await f.service.status()).phase, 'enabled')
  await f.service.disable()
  assert.equal(f.config().Web[key].Handlers['/'], undefined)
})

test('a failed resume removes only its own root forwarding', async () => {
  const config = { Web: { [key]: { Handlers: { '/': { Proxy: own(50123) }, '/other': { Proxy: 'http://127.0.0.1:9999' } } } } }
  const f = fixture({ prefs: { enabled: true, origin, port: 50123 }, config, proxyError: true })
  await f.service.resume()
  assert.equal(f.config().Web[key].Handlers['/'], undefined)
  assert(f.config().Web[key].Handlers['/other'])
  const view = await f.service.status()
  assert.equal(view.phase, 'ready')
  assert.match(view.reason, /重新启用/)

  const foreign = fixture({ prefs: { enabled: true, origin, port: 50123 }, proxyError: true,
    config: { Web: { [key]: { Handlers: { '/': { Proxy: own(50999) } } } } } })
  await foreign.service.resume()
  assert(!foreign.calls.some(c => c.args.includes('off')))
  assert.equal(foreign.config().Web[key].Handlers['/'].Proxy, own(50999))
})

test('status removes its forwarding while no proxy is running', async () => {
  const f = fixture({ prefs: { enabled: true, origin, port: 50123 }, config: { Web: { [key]: { Handlers: { '/': { Proxy: own(50123) } } } } } })
  assert.equal((await f.service.status()).phase, 'ready')
  assert.equal(f.config().Web[key].Handlers['/'], undefined)
  assert.equal(f.running(), 0)
})

test('a proxy that cannot restart over its own forwarding fails closed', async () => {
  const f = fixture({ prefs: { enabled: true, origin, port: 50123 }, proxyError: true,
    config: { Web: { [key]: { Handlers: { '/': { Proxy: own(50123) } } } } } })
  await assert.rejects(f.service.enable(), /occupied/)
  assert.equal(f.config().Web[key].Handlers['/'], undefined)
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
