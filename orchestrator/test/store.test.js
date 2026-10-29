import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot, until, withHost } from './helpers/host.js'

for (const version of [1, 2]) test(`startup removes retired data from v${version} while preserving conversations and workspace files`, async () => {
  const home = mkdtempSync(join(tmpdir(), 'nodo-store-cleanup-'))
  const attachments = join(home, 'workspace', '.nodo', 'workflow-inputs')
  mkdirSync(attachments, { recursive: true })
  writeFileSync(join(attachments, 'keep.txt'), 'user file')
  mkdirSync(join(home, 'runs'))
  writeFileSync(join(home, 'runs', 'old.json'), '{}')
  writeFileSync(join(home, 'keep.txt'), 'other home data')
  const state = { version, workflows: { old: { id: 'old' } }, profiles: {},
    workspaces: { ws: { id: 'ws', name: 'Workspace', cwd: join(home, 'workspace') } },
    transcripts: { session: [{ who: 'user', text: 'keep history' }] }, prefs: { marker: 'keep' } }
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  let host = boot(home)
  try {
    const rt = await host.runtime
    const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    assert.equal(Object.hasOwn(rt.state, 'workflows'), false)
    assert.equal(Object.hasOwn(saved, 'workflows'), false)
    assert.equal(saved.version, 2)
    assert.deepEqual(saved.transcripts, state.transcripts)
    assert.deepEqual(saved.workspaces, state.workspaces)
    assert.deepEqual(saved.prefs, state.prefs)
    assert.equal(existsSync(join(home, 'runs')), false)
    assert.equal(readFileSync(join(attachments, 'keep.txt'), 'utf8'), 'user file')
    assert.equal(readFileSync(join(home, 'keep.txt'), 'utf8'), 'other home data')
    const view = await host.api('state')
    assert.equal(Object.hasOwn(view, 'workflows'), false)
    assert.equal(Object.hasOwn(view, 'runs'), false)
    for (const endpoint of ['workflow-create', 'workflow-update', 'workflow-delete', 'workflow-run', 'run-list', 'run-get', 'run-cancel', 'run-reconcile']) {
      assert.equal((await host.post(endpoint, {})).error.code, 'orch/not-found', endpoint)
    }
    host.dispose()
    host = boot(home)
    await host.runtime
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')), saved, 'restart does not write again')
  } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('a reader leaves retired data on disk until it takes the state lock', async () => {
  await withHost(async ({ runtime, home, dispose }) => {
    const writer = await runtime
    await writer.save()
    const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    saved.workflows = { old: {} }
    dispose()
    writeFileSync(join(home, 'state.json'), JSON.stringify(saved))
    writeFileSync(join(home, 'state.lock'), JSON.stringify({ host: 'fixture-other-host', token: 'fixture' }))
    mkdirSync(join(home, 'runs'))
    writeFileSync(join(home, 'runs', 'old.json'), '{}')
    const reader = boot(home)
    try {
      const rt = await reader.runtime
      assert.ok(rt.readOnly())
      assert.equal(Object.hasOwn(rt.state, 'workflows'), false)
      assert.equal(existsSync(join(home, 'runs', 'old.json')), true)
      assert.deepEqual(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')), saved)
      rmSync(join(home, 'state.lock'))
      await rt.refresh()
      assert.equal(rt.readOnly(), undefined)
      assert.equal(existsSync(join(home, 'runs')), false)
      assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')), 'workflows'), false)
    } finally { reader.dispose() }
  })
})

test('saves made before a write starts share it, and a change during a write lands in the next one', async () => {
  await withHost(async ({ runtime, home }) => {
    const rt = await runtime
    await until(() => {
      try { return !!JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).probe }
      catch { return false }
    })
    await rt.save()
    const stringify = JSON.stringify
    let writes = 0
    JSON.stringify = function (value, ...rest) {
      if (value === rt.state) writes += 1
      return stringify.call(this, value, ...rest)
    }
    try {
      await Promise.all(Array.from({ length: 100 }, () => rt.save()))
      assert.equal(writes, 1, 'a burst of saves is one write')

      const first = rt.save()
      await new Promise(resolve => setImmediate(resolve))
      rt.state.prefs.marker = 'late'
      await Promise.all([first, rt.save()])
      assert.equal(writes, 3, 'a save during a write queues the next one')
    } finally { JSON.stringify = stringify }
    const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    assert.equal(saved.prefs.marker, 'late')
    assert.equal(saved.revision, rt.state.revision)
  })
})
