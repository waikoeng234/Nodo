import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/remote.js'

function fixture(readOnly = null, { get = () => undefined, prefs = {} } = {}) {
  const cleanups = []
  const rt = {
    ctx: {
      get,
      get webServer() { throw new Error('undeclared service access') },
      connection: {}, effect: factory => { cleanups.push(factory()) },
    },
    state: { prefs }, readOnly: () => readOnly,
    saveStrict: async () => { throw new Error('unexpected preference write') },
    handle: async (endpoint, payload) => ({ endpoint, payload }), load: async () => {},
  }
  install(rt)
  return { rt, close: () => Promise.all(cleanups.map(fn => fn())) }
}

test('a host without browser capabilities keeps Nodo routes working and reports unsupported', async () => {
  const f = fixture()
  try {
    await f.rt.load()
    const value = await f.rt.handle('remote-status')
    assert.equal(value.ok, true)
    assert.equal(value.value.phase, 'unsupported')
    assert.deepEqual(await f.rt.handle('existing', { id: 1 }), { endpoint: 'existing', payload: { id: 1 } })
  } finally { await f.close() }
})

test('read-only hosts reject every remote action except inspecting status', async () => {
  const f = fixture('当前宿主只读')
  try {
    await f.rt.load()
    for (const action of ['open', 'enable', 'disable', 'login']) {
      const result = await f.rt.handle(`remote-${action}`)
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'orch/read-only')
    }
    assert.equal((await f.rt.handle('remote-status')).ok, true)
  } finally { await f.close() }
})

test('a host without a service accessor or a declared web server still loads and reports unsupported', async () => {
  const f = fixture(null, { get: null })
  try {
    await f.rt.load()
    assert.equal((await f.rt.handle('remote-status')).value.phase, 'unsupported')
  } finally { await f.close() }
})

test('remote access is restored once per host process, not on every load', async () => {
  let reads = 0
  const prefs = { get remoteAccess() { reads++; return { enabled: true } } }
  const f = fixture(null, { prefs })
  try {
    await f.rt.load()
    await new Promise(resolve => setImmediate(resolve))
    const once = reads
    for (let i = 0; i < 2; i++) await f.rt.load()
    await new Promise(resolve => setImmediate(resolve))
    assert(once > 0)
    assert.equal(reads, once)
  } finally { await f.close() }
})
