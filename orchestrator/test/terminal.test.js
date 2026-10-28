import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { install } from '../src/host/terminal.js'
import { install as installSessions } from '../core/src/sessions.js'
import { withHost } from './helpers/host.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

function provider() {
  const handles = [], specs = []
  return {
    handles, specs,
    terminalEnvironment: async () => ({ platform: 'posix', defaultShell: '/bin/test-shell' }),
    resolveExecutable: async shell => shell,
    async spawnTerminal(spec) {
      specs.push(spec)
      let resolve, reject
      const handle = { output: new PassThrough(), writes: [], sizes: [], terminated: 0,
        done: new Promise((yes, no) => { resolve = yes; reject = no }),
        write: async data => { handle.writes.push(data) }, resize: async (...size) => { handle.sizes.push(size) },
        terminate: async () => { handle.terminated++; handle.output.end(); resolve({ exitCode: null, signal: 'SIGTERM' }) },
        exit(code = 0) { handle.output.end(); resolve({ exitCode: code, signal: null }) },
        fail() { handle.output.destroy(new Error('private output')); reject(new Error('private output')) },
      }
      handles.push(handle)
      return handle
    },
  }
}

function setup(subprocess = provider()) {
  const disposers = [], routes = [], bindings = []
  const rt = {
    ctx: { inject(deps, run) { bindings.push({ deps, run }); if (subprocess) disposers.push(run({ subprocess })) },
      effect(run) { disposers.push(run()) }, connection: { fetch: { register(route) { routes.push(route); return () => {} } } } },
    state: { profiles: { role: { id: 'role', sessions: [{ id: 'first', cwd: '/worktree' }, { id: 'second' }] } } },
    save: async () => {}, refresh: async () => {}, readOnly: () => undefined,
    sessionWorkspace: () => ({ cwd: '/workspace' }), handle: async () => ({ ok: true, value: {} }),
  }
  installSessions(rt)
  rt.sessionWorkspace = () => ({ cwd: '/workspace' })
  install(rt)
  const request = body => routes[0].fetch(new Request('http://host/api/nodo/terminal', { method: 'POST', body: JSON.stringify(body) }))
  const post = async body => (await request({ profile: 'role', session: 'first', ...body })).json()
  const create = async (session = 'first', extra = {}) => {
    const result = await post({ op: 'create', profile: 'role', session, cols: 80, rows: 24, ...extra })
    assert.equal(result.ok, true)
    return result.value.id
  }
  const stream = async (id, since = 0, signal) => (await routes[0].fetch(new Request(`http://host/api/nodo/terminal?profile=role&session=first&id=${id}&since=${since}`, { signal }))).body.getReader()
  return { rt, subprocess, routes, bindings, post, request, create, stream,
    dispose: async () => { for (const stop of [...disposers].reverse()) await stop?.() } }
}
const frame = async reader => { const value = await reader.read(); return value.done ? null : JSON.parse(new TextDecoder().decode(value.value)) }

test('terminal cwd is resolved from the session or its workspace; dimensions and text pass to the provider', async () => {
  const h = setup()
  try {
    const id = await h.create('first', { cwd: '/untrusted', argv: ['ignored'] })
    await h.create('second')
    assert.equal(h.subprocess.specs[0].cwd, '/worktree')
    assert.equal(h.subprocess.specs[1].cwd, '/workspace')
    assert.deepEqual(h.subprocess.specs[0].argv, ['/bin/test-shell', '-l', '-i'])
    assert.equal(h.subprocess.specs[0].terminalType, 'xterm-256color')
    assert.equal(h.subprocess.specs[0].graceMs, 1500)
    assert.equal(h.subprocess.specs[0].env, undefined)
    assert.equal((await h.post({ op: 'write', id, data: 'echo test\r' })).ok, true)
    assert.equal((await h.post({ op: 'resize', id, cols: 101, rows: 37 })).ok, true)
    assert.deepEqual(h.subprocess.handles[0].writes, ['echo test\r'])
    assert.deepEqual(h.subprocess.handles[0].sizes, [[101, 37]])
    assert.equal((await h.post({ op: 'resize', id, cols: 0, rows: 1 })).ok, false)
    assert.equal((await h.post({ op: 'resize', id, cols: 2000, rows: 1500 })).ok, true)
    assert.equal((await h.post({ op: 'resize', id, cols: 32768, rows: 1 })).ok, false)
    const list = await h.post({ op: 'list', profile: 'role', session: 'second' })
    assert.equal(list.value.terminals.length, 1)
  } finally { await h.dispose() }
})

test('terminal records carry only the shell basename', async () => {
  const h = setup()
  try {
    const id = await h.create('first')
    const [value] = (await h.post({ op: 'list', profile: 'role', session: 'first' })).value.terminals
    assert.deepEqual(value, { id, cols: 80, rows: 24, shell: 'test-shell' })
  } finally { await h.dispose() }
})

test('terminal operations require the matching profile and explicit session', async () => {
  const h = setup()
  try {
    const id = await h.create()
    h.rt.state.profiles.other = { id: 'other', sessions: [{ id: 'third' }] }
    for (const scope of [{}, { profile: 'role' }, { session: 'first' }, { profile: 'role', session: 'second' }, { profile: 'other', session: 'third' }]) {
      for (const op of ['write', 'resize', 'close']) {
        const response = await h.request({ op, id, data: 'test', cols: 80, rows: 24, ...scope })
        assert.equal(response.status, 404, `${op} ${JSON.stringify(scope)}`)
        assert.equal((await response.json()).error.code, 'terminal/not-found')
      }
      const query = new URLSearchParams({ ...scope, id })
      const response = await h.routes[0].fetch(new Request(`http://host/api/nodo/terminal?${query}`))
      assert.equal(response.status, 404, `GET ${JSON.stringify(scope)}`)
      assert.equal((await response.json()).error.code, 'terminal/not-found')
    }
    assert.deepEqual(h.subprocess.handles[0].writes, [])
    assert.deepEqual(h.subprocess.handles[0].sizes, [])
    assert.equal(h.subprocess.handles[0].terminated, 0)
  } finally { await h.dispose() }
})

test('terminal writes enforce the 1 MiB limit in UTF-8 bytes', async () => {
  const h = setup()
  try {
    const id = await h.create(), data = '😀'.repeat(256 * 1024)
    assert.equal((await h.post({ op: 'write', id, data })).ok, true)
    assert.equal((await h.post({ op: 'write', id, data: data + 'x' })).ok, false)
    assert.equal(h.subprocess.handles[0].writes.length, 1)
    assert.equal(Buffer.byteLength(h.subprocess.handles[0].writes[0]), 1024 * 1024)
  } finally { await h.dispose() }
})

test('terminal GET rejects negative or fractional since and unknown ids', async () => {
  const h = setup()
  try {
    const id = await h.create()
    for (const since of ['-1', '1.5', 'NaN']) {
      const response = await h.routes[0].fetch(new Request(`http://host/api/nodo/terminal?profile=role&session=first&id=${id}&since=${since}`))
      assert.equal(response.status, 400)
    }
    const response = await h.routes[0].fetch(new Request('http://host/api/nodo/terminal?profile=role&session=first&id=unknown'))
    assert.equal(response.status, 404)
    assert.equal((await response.json()).error.code, 'terminal/not-found')
  } finally { await h.dispose() }
})

test('terminal byte buffer is bounded and replays since, including multibyte output and stale offsets', async () => {
  const h = setup()
  try {
    const id = await h.create(), handle = h.subprocess.handles[0]
    handle.output.write(Buffer.alloc(300 * 1024, 65))
    handle.output.write(Buffer.from('你好'))
    await tick()
    handle.exit(3); await tick()
    const reader = await h.stream(id)
    const reset = await frame(reader), output = await frame(reader), exit = await frame(reader)
    assert.deepEqual(reset, { type: 'reset', seq: 300 * 1024 + 6 - 256 * 1024 })
    assert.equal(Buffer.from(output.data, 'base64').length, 256 * 1024)
    assert.equal(Buffer.from(output.data, 'base64').subarray(-6).toString(), '你好')
    assert.equal(output.seq, 300 * 1024 + 6)
    assert.equal(exit.type, 'exit'); assert.equal(exit.code, 3)
    assert.equal(await frame(reader), null)
    const resumed = await h.stream(id, 300 * 1024)
    assert.equal(Buffer.from((await frame(resumed)).data, 'base64').toString(), '你好')
    await resumed.cancel()
    assert.equal((await h.post({ op: 'list', profile: 'role', session: 'first' })).value.terminals[0].exited.code, 3)
  } finally { await h.dispose() }
})

test('terminal buffer trimming skips UTF-8 continuation bytes, including split provider chunks', async () => {
  for (const split of [false, true]) {
    const h = setup()
    try {
      const id = await h.create(), handle = h.subprocess.handles[0]
      const bytes = Buffer.from('A'.repeat(262142) + '你' + 'A'.repeat(262142))
      if (split) { handle.output.write(bytes.subarray(0, 262143)); await tick(); handle.output.write(bytes.subarray(262143)) }
      else handle.output.write(bytes)
      handle.exit(); await tick()
      const reader = await h.stream(id), reset = await frame(reader), output = await frame(reader)
      assert.equal(reset.seq, 262145)
      assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(output.data, 'base64')), 'A'.repeat(262142))
      await reader.cancel()
    } finally { await h.dispose() }
  }
})

test('pending termination never blocks save or refresh and failed cleanup remains retryable', async () => {
  const h = setup()
  try {
    await h.create()
    const handle = h.subprocess.handles[0], terminate = handle.terminate
    let release
    handle.terminate = () => new Promise(resolve => { release = resolve })
    h.rt.state.profiles.role.sessions[0].archivedAt = 1
    await h.rt.save(); await h.rt.refresh(); await tick()
    assert.equal(typeof release, 'function')
    release(); await tick()
    assert.deepEqual((await h.post({ op: 'list', profile: 'role', session: 'first' })).value.terminals, [])
    await terminate()
  } finally { await h.dispose() }
})

test('cleanup rejection keeps closed terminals hidden and refresh retries their process cleanup without poisoning state', async () => {
  const subprocess = provider()
  await withHost(async host => {
    const rt = await host.runtime
    const workspace = await host.api('workspace-create', { name: 'Cleanup', cwd: host.home })
    const profile = await host.api('profile-create', { name: 'Cleanup role', engine: 'echo' })
    const session = await host.api('session-create', { profile: profile.id, workspace: workspace.id, lazy: true })
    const route = host.routes.find(route => route.path === '/api/nodo/terminal')
    const post = async body => (await route.fetch(new Request('http://host/api/nodo/terminal', { method: 'POST', body: JSON.stringify({ profile: profile.id, session: session.id, ...body }) }))).json()
    const id = (await post({ op: 'create', cols: 80, rows: 24 })).value.id
    const handle = subprocess.handles[0], terminate = handle.terminate
    let fail = true
    handle.terminate = async () => { if (fail) throw new Error('surviving process'); await terminate() }
    assert.equal((await post({ op: 'close', id })).ok, true)
    await host.api('session-archive', { profile: profile.id, session: session.id, archived: true })
    await assert.doesNotReject(rt.save())
    await assert.doesNotReject(rt.refresh())
    assert.equal((await host.post('state', {})).ok, true)
    assert.deepEqual((await post({ op: 'list' })).value.terminals, [])
    fail = false
    await rt.refresh(); await tick()
    assert.deepEqual((await post({ op: 'list' })).value.terminals, [])
    assert.equal(handle.terminated, 1)
  }, { subprocess })
})

test('terminal streams live output before final exit, and disconnect never terminates the process', async () => {
  const h = setup()
  try {
    const id = await h.create(), handle = h.subprocess.handles[0], abort = new AbortController()
    const reader = await h.stream(id, 0, abort.signal)
    const first = frame(reader)
    handle.output.write(Buffer.from([0xe4])); await tick()
    assert.equal(Buffer.from((await first).data, 'base64')[0], 0xe4)
    abort.abort(); await reader.cancel()
    assert.equal(handle.terminated, 0)
    handle.output.write(Buffer.from([0xbd, 0xa0]))
    handle.exit(); await tick()
    const resumed = await h.stream(id, 1)
    assert.deepEqual([...Buffer.from((await frame(resumed)).data, 'base64')], [0xbd, 0xa0])
    assert.equal((await frame(resumed)).type, 'exit')
    assert.equal(await frame(resumed), null)
  } finally { await h.dispose() }
})

test('slow terminal consumers catch up from the bounded buffer and cannot accumulate an unbounded stream queue', async () => {
  const h = setup()
  try {
    const id = await h.create(), reader = await h.stream(id), handle = h.subprocess.handles[0]
    handle.output.write('first'); await tick()
    for (let i = 0; i < 10; i++) { handle.output.write(Buffer.alloc(128 * 1024, i)); await tick() }
    assert.equal((await frame(reader)).type, 'output')
    assert.equal((await frame(reader)).type, 'reset')
    assert.equal(Buffer.from((await frame(reader)).data, 'base64').length, 256 * 1024)
    await reader.cancel()
  } finally { await h.dispose() }
})

test('closing a terminal returns and ends its stream before pending termination completes', async () => {
  const h = setup()
  const gate = Promise.withResolvers()
  let closing
  try {
    const id = await h.create(), handle = h.subprocess.handles[0], terminate = handle.terminate
    const reader = await h.stream(id)
    const next = frame(reader)
    let started = 0, settled = false
    handle.terminate = async () => { started++; await gate.promise; await terminate() }
    closing = h.post({ op: 'close', id }).then(value => { settled = true; return value })
    await tick()
    assert.equal(settled, true, 'close must not wait for provider termination')
    assert.equal((await closing).ok, true)
    assert.equal(started, 1)
    assert.deepEqual((await h.post({ op: 'list', profile: 'role', session: 'first' })).value.terminals, [])
    handle.output.write('late output'); await tick()
    assert.equal((await next).type, 'exit')
    assert.equal(await frame(reader), null)
    assert.equal((await h.post({ op: 'write', id, data: 'ignored' })).error.code, 'terminal/not-found')
    const response = await h.routes[0].fetch(new Request(`http://host/api/nodo/terminal?profile=role&session=first&id=${id}`))
    assert.equal(response.status, 404)
    gate.resolve(); await tick()
    assert.equal(handle.terminated, 1)
  } finally { gate.resolve(); await closing; await h.dispose() }
})

test('plugin unload waits for a closed terminal still being terminated in the background', async () => {
  const h = setup(), gate = Promise.withResolvers()
  let disposal
  try {
    const id = await h.create(), handle = h.subprocess.handles[0], terminate = handle.terminate
    let closed = false, disposed = false, attempts = 0
    handle.terminate = async () => { attempts++; await gate.promise; await terminate() }
    const closing = h.post({ op: 'close', id }).then(() => { closed = true })
    await tick()
    assert.equal(closed, true)
    await closing
    disposal = h.dispose().then(() => { disposed = true })
    await tick()
    assert.equal(disposed, false)
    gate.resolve(); await disposal
    assert.equal(attempts, 1)
    assert.equal(handle.terminated, 1)
  } finally { gate.resolve(); await (disposal ?? h.dispose()) }
})

test('plugin unload retries failed cleanup of an already hidden terminal', async () => {
  const h = setup()
  const id = await h.create(), handle = h.subprocess.handles[0], terminate = handle.terminate
  let attempts = 0
  handle.terminate = async () => { if (++attempts === 1) throw new Error('private output'); await terminate() }
  assert.equal((await h.post({ op: 'close', id })).ok, true)
  await tick()
  assert.equal(attempts, 1)
  await h.dispose()
  assert.equal(attempts, 2)
  assert.equal(handle.terminated, 1)
})

for (const action of ['archive', 'delete', 'unload']) test(`${action} terminates all affected terminals`, async () => {
  const h = setup()
  await h.create(); await h.create()
  if (action === 'archive') await h.rt.archiveSession('role', 'first', true)
  else if (action === 'delete') { h.rt.state.profiles.role.sessions = []; await h.rt.save() }
  if (action !== 'unload') {
    await tick()
    assert.deepEqual(h.subprocess.handles.map(handle => handle.terminated), [1, 1])
  }
  await h.dispose()
  assert.deepEqual(h.subprocess.handles.map(handle => handle.terminated), [1, 1])
})

test('missing subprocess keeps state and routes available; optional binding can appear and disappear', async () => {
  const h = setup(null)
  assert.deepEqual(h.bindings[0].deps, ['subprocess'])
  assert.equal('terminal' in (await h.rt.handle('state', {})).value, false)
  assert.equal((await h.post({ op: 'list', profile: 'role', session: 'first' })).value.available, false)
  assert.equal((await h.post({ op: 'create', profile: 'role', session: 'first', cols: 80, rows: 24 })).ok, false)
  const subprocess = provider(), remove = h.bindings[0].run({ subprocess })
  assert.equal((await h.post({ op: 'list', profile: 'role', session: 'first' })).value.available, true)
  await h.create(); await remove()
  assert.equal(subprocess.handles[0].terminated, 1)
  assert.equal((await h.post({ op: 'list', profile: 'role', session: 'first' })).value.available, false)
  await h.dispose()
})

test('a late allocation after plugin unload is rejected and included in unload cleanup', async () => {
  const subprocess = provider(), spawn = subprocess.spawnTerminal
  let release
  subprocess.spawnTerminal = async spec => { await new Promise(resolve => { release = resolve }); return spawn(spec) }
  const h = setup(subprocess)
  const creating = h.post({ op: 'create', profile: 'role', session: 'first', cols: 80, rows: 24 })
  await tick()
  const disposal = h.dispose()
  release()
  assert.equal((await creating).ok, false)
  await disposal
  assert.equal(subprocess.handles[0].terminated, 1)
})

test('provider failure never exposes terminal content through errors', async () => {
  const h = setup()
  try {
    const id = await h.create()
    h.subprocess.handles[0].write = async () => { throw new Error('private output') }
    assert.doesNotMatch(JSON.stringify(await h.post({ op: 'write', id, data: 'test' })), /private output/)
    h.subprocess.handles[0].fail(); await tick()
    assert.equal(h.subprocess.handles[0].terminated, 1)
  } finally { await h.dispose() }
})

test('the full plugin loads without subprocess and leaves terminal availability to list', async () => {
  await withHost(async host => {
    const state = await host.api('state')
    assert.equal('terminal' in state, false)
    const unchanged = await host.api('state', { since: state.revision })
    assert.equal(unchanged.unchanged, true)
    assert.equal('terminal' in unchanged, false)
  })
})

for (const kind of ['profile', 'workspace']) test(`the ${kind}-delete API terminates the archived session's terminals`, async () => {
  const subprocess = provider()
  await withHost(async host => {
    await host.runtime
    const workspace = await host.api('workspace-create', { name: 'Terminal test', cwd: host.home })
    const profile = await host.api('profile-create', { name: 'Terminal role', engine: 'echo' })
    const session = await host.api('session-create', { profile: profile.id, workspace: workspace.id, lazy: true })
    const route = host.routes.find(route => route.path === '/api/nodo/terminal')
    const response = await route.fetch(new Request('http://host/api/nodo/terminal', { method: 'POST', body: JSON.stringify({
      op: 'create', profile: profile.id, session: session.id, cols: 80, rows: 24,
    }) }))
    assert.equal((await response.json()).ok, true)
    await host.api(`${kind}-delete`, { id: kind === 'profile' ? profile.id : workspace.id })
    assert.equal(subprocess.handles[0].terminated, 1)
  }, { subprocess })
})
