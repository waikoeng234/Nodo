import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { symlinkSync, realpathSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
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
    state: { workspaces: { main: { id: 'main', cwd: '/workspace' }, branch: { id: 'branch', cwd: '/worktree' } },
      profiles: { role: { id: 'role', sessions: [{ id: 'first', cwd: '/worktree' }, { id: 'second' }] } } },
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

test('a welcome workspace and sessions at its real cwd share terminals, streams and control across roles', async () => {
  const subprocess = provider()
  await withHost(async host => {
    const rt = await host.runtime
    const alias = join(host.home, 'alias')
    symlinkSync(host.home, alias)
    const workspace = await host.api('workspace-create', { name: 'Shared', cwd: alias })
    const other = await host.api('workspace-create', { name: 'Other', cwd: join(host.home, 'other') })
    const roles = await Promise.all(['One', 'Two'].map(name => host.api('profile-create', { name, engine: 'echo' })))
    const sessions = await Promise.all(roles.map(role => host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true })))
    rt.conversation(roles[1].id, sessions[1].id).session.cwd = realpathSync(host.home)
    await rt.save()
    const route = host.routes.find(route => route.path === '/api/nodo/terminal')
    const post = async body => (await route.fetch(new Request('http://host/api/nodo/terminal', { method: 'POST', body: JSON.stringify(body) }))).json()
    const scopes = [{ workspace: workspace.id }, ...sessions.map((session, i) => ({ profile: roles[i].id, session: session.id }))]
    const id = (await post({ op: 'create', ...scopes[0], cols: 80, rows: 24, cwd: '/untrusted' })).value.id
    assert.equal(subprocess.specs[0].cwd, realpathSync(host.home))
    for (const scope of scopes) {
      const value = (await post({ op: 'list', ...scope })).value
      assert.equal(value.cwd, realpathSync(host.home))
      assert.deepEqual(value.terminals.map(terminal => terminal.id), [id])
      assert.equal((await post({ op: 'write', ...scope, id, data: 'shared' })).ok, true)
    }
    assert.deepEqual((await post({ op: 'list', workspace: other.id, cwd: alias })).value.terminals, [])
    assert.equal((await post({ op: 'write', workspace: other.id, cwd: alias, id, data: 'denied' })).ok, false)
    for (const scope of [{ cwd: alias }, { profile: roles[0].id }, { workspace: 'missing' }, { workspace: workspace.id, ...scopes[1] }]) {
      for (const op of ['list', 'create']) assert.equal((await post({ op, ...scope, cols: 80, rows: 24 })).ok, false)
    }
    const response = await route.fetch(new Request(`http://host/api/nodo/terminal?workspace=${workspace.id}&id=${id}`))
    const reader = response.body.getReader(), next = frame(reader)
    subprocess.handles[0].output.write('welcome'); await tick()
    assert.equal(Buffer.from((await next).data, 'base64').toString(), 'welcome')
    await reader.cancel()
    for (let i = 0; i < sessions.length; i++) {
      await host.api('session-archive', { ...scopes[i + 1], archived: true })
      assert.equal((await post({ op: 'list', ...scopes[i + 1] })).ok, false)
      assert.deepEqual((await post({ op: 'list', ...scopes[0] })).value.terminals.map(terminal => terminal.id), [id])
      assert.equal(subprocess.handles[0].terminated, 0)
    }
    await host.api('workspace-delete', { id: workspace.id })
    assert.equal(subprocess.handles[0].terminated, 1)
    assert.equal((await post({ op: 'list', ...scopes[0] })).ok, false)
  }, { subprocess })
})

test('read-only mode refuses creation but keeps open terminals usable for both target forms', async () => {
  const h = setup()
  try {
    const id = await h.create()
    h.rt.readOnly = () => 'read-only'
    for (const scope of [{ workspace: 'branch' }, { profile: 'role', session: 'first' }]) {
      const value = await (await h.request({ op: 'list', ...scope })).json()
      assert.equal(value.value.available, false)
      assert.deepEqual(value.value.terminals.map(terminal => terminal.id), [id])
      assert.equal((await (await h.request({ op: 'create', ...scope, cols: 80, rows: 24 })).json()).ok, false)
      assert.equal((await (await h.request({ op: 'write', ...scope, id, data: 'typed' })).json()).ok, true)
      assert.equal((await (await h.request({ op: 'resize', ...scope, id, cols: 90, rows: 30 })).json()).ok, true)
    }
    assert.equal(h.subprocess.handles.length, 1)
    assert.deepEqual(h.subprocess.handles[0].writes, ['typed', 'typed'])
    assert.deepEqual(h.subprocess.handles[0].sizes, [[90, 30], [90, 30]])
    assert.equal((await (await h.request({ op: 'close', workspace: 'branch', id })).json()).ok, true)
    assert.equal(h.subprocess.handles[0].terminated, 1)
  } finally { await h.dispose() }
})

test('a valid old session without a cwd lists unavailable terminals without falling back to another session', async () => {
  const h = setup()
  try {
    await h.create()
    h.rt.state.profiles.role.activeSessionId = 'first'
    h.rt.sessionWorkspace = () => undefined
    assert.deepEqual(await h.post({ op: 'list', session: 'second' }), { ok: true, value: { available: false, terminals: [] } })
    assert.equal((await h.post({ op: 'create', session: 'second', cols: 80, rows: 24 })).ok, false)
    assert.equal((await h.post({ op: 'list', session: undefined })).ok, false)
    assert.equal(h.subprocess.handles.length, 1)
  } finally { await h.dispose() }
})

test('a non-ENOENT realpath failure keeps referenced terminals alive until cwd resolution recovers', async () => {
  const subprocess = provider()
  await withHost(async host => {
    const rt = await host.runtime, alias = join(host.home, 'terminal-alias')
    symlinkSync(host.home, alias)
    const workspace = await host.api('workspace-create', { name: 'Linked terminal', cwd: alias })
    const route = host.routes.find(route => route.path === '/api/nodo/terminal')
    const post = async body => (await route.fetch(new Request('http://host/api/nodo/terminal', { method: 'POST', body: JSON.stringify({ workspace: workspace.id, ...body }) }))).json()
    const id = (await post({ op: 'create', cols: 80, rows: 24 })).value.id
    unlinkSync(alias); symlinkSync(alias, alias)
    assert.throws(() => realpathSync(alias), { code: 'ELOOP' })
    await rt.save(); await rt.refresh(); await tick()
    assert.equal(subprocess.handles[0].terminated, 0)
    unlinkSync(alias); symlinkSync(host.home, alias)
    await rt.refresh()
    assert.deepEqual((await post({ op: 'list' })).value.terminals.map(terminal => terminal.id), [id])
    await host.api('workspace-delete', { id: workspace.id })
    assert.equal(subprocess.handles[0].terminated, 1)
  }, { subprocess })
})

test('a permanently broken path shields only its own terminal while another deleted project is reclaimed', async () => {
  const subprocess = provider()
  await withHost(async host => {
    const rt = await host.runtime
    const kept = join(host.home, 'terminal-kept'), loop = join(host.home, 'terminal-loop'), doomed = join(host.home, 'terminal-doomed')
    mkdirSync(kept); mkdirSync(doomed); symlinkSync(kept, loop)
    const loopWorkspace = await host.api('workspace-create', { name: 'Loop', cwd: loop })
    const doomedWorkspace = await host.api('workspace-create', { name: 'Doomed', cwd: doomed })
    const route = host.routes.find(route => route.path === '/api/nodo/terminal')
    const create = async workspace => (await (await route.fetch(new Request('http://host/api/nodo/terminal', { method: 'POST', body: JSON.stringify({ op: 'create', workspace, cols: 80, rows: 24 }) }))).json()).value.id
    await create(loopWorkspace.id)
    await create(doomedWorkspace.id)
    unlinkSync(loop); symlinkSync(loop, loop)
    assert.throws(() => realpathSync(loop), { code: 'ELOOP' })
    await host.api('workspace-delete', { id: doomedWorkspace.id })
    await rt.refresh(); await tick()
    assert.equal(subprocess.handles[1].terminated, 1)
    assert.equal(subprocess.handles[0].terminated, 0)
  }, { subprocess })
})

test('archiving or deleting a role retains its terminals while a workspace references their cwd', async () => {
  const h = setup()
  try {
    const id = await h.create()
    await h.rt.archiveSession('role', 'first', true)
    h.rt.state.profiles.role.deletedAt = 1
    await h.rt.save()
    assert.equal(h.subprocess.handles[0].terminated, 0)
    for (const op of ['list', 'create', 'write', 'resize', 'close']) {
      assert.equal((await h.post({ op, id, data: 'denied', cols: 80, rows: 24 })).ok, false)
    }
    assert.deepEqual(h.subprocess.handles[0].writes, [])
    assert.deepEqual(h.subprocess.handles[0].sizes, [])
    const list = await (await h.request({ op: 'list', workspace: 'branch' })).json()
    assert.deepEqual(list.value.terminals.map(terminal => terminal.id), [id])
    delete h.rt.state.workspaces.branch
    await h.rt.save(); await tick()
    assert.equal(h.subprocess.handles[0].terminated, 1)
  } finally { await h.dispose() }
})

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

test('terminal operations require a valid workspace or explicit session at the same cwd', async () => {
  const h = setup()
  try {
    const id = await h.create()
    h.rt.state.profiles.other = { id: 'other', sessions: [{ id: 'third' }] }
    for (const scope of [{}, { cwd: '/worktree' }, { workspace: 'missing' }, { profile: 'role' }, { session: 'first' }, { profile: 'role', session: 'second' }, { profile: 'other', session: 'third' }]) {
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

for (const trigger of ['save', 'refresh']) test(`sweep-triggered termination never blocks ${trigger}`, async () => {
  const h = setup(), gate = Promise.withResolvers()
  let sweeping
  try {
    await h.create()
    const handle = h.subprocess.handles[0], terminate = handle.terminate
    let started = false, settled = false
    handle.terminate = async () => { started = true; await gate.promise; await terminate() }
    delete h.rt.state.workspaces.branch
    h.rt.state.profiles.role.sessions[0].archivedAt = 1
    sweeping = h.rt[trigger]().then(() => { settled = true })
    await tick()
    assert.equal(started, true, 'sweep must initiate process termination')
    assert.equal(settled, true, 'state operations must finish while termination is pending')
    assert.equal(handle.terminated, 0)
    h.rt.state.profiles.role.sessions[0].archivedAt = undefined
    assert.deepEqual((await h.post({ op: 'list' })).value.terminals, [], 'swept terminals stay hidden while the provider is pending')
    gate.resolve(); await sweeping; await tick()
    assert.equal(handle.terminated, 1)
  } finally { gate.resolve(); await sweeping; await h.dispose() }
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
    assert.deepEqual((await post({ op: 'list', workspace: workspace.id, profile: undefined, session: undefined })).value.terminals, [])
    fail = false
    await rt.refresh(); await tick()
    assert.deepEqual((await post({ op: 'list', workspace: workspace.id, profile: undefined, session: undefined })).value.terminals, [])
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

for (const action of ['unreferenced', 'unload']) test(`${action} terminates all affected terminals`, async () => {
  const h = setup()
  await h.create(); await h.create()
  if (action === 'unreferenced') { h.rt.state.profiles.role.sessions = []; delete h.rt.state.workspaces.branch; await h.rt.save() }
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

for (const kind of ['profile', 'workspace']) test(`the ${kind}-delete API keeps terminals only while their cwd is referenced`, async () => {
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
    assert.equal(subprocess.handles[0].terminated, kind === 'workspace' ? 1 : 0)
    if (kind === 'profile') {
      const listed = await route.fetch(new Request('http://host/api/nodo/terminal', { method: 'POST', body: JSON.stringify({ op: 'list', workspace: workspace.id }) }))
      assert.equal((await listed.json()).value.terminals.length, 1)
      await host.api('workspace-delete', { id: workspace.id })
      assert.equal(subprocess.handles[0].terminated, 1)
    }
  }, { subprocess })
})
