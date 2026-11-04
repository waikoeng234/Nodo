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
    assert.equal(saved.version, 4)
    assert.equal(Object.hasOwn(saved, 'transcripts'), false)
    assert.equal(Object.hasOwn(saved, 'transcriptIndex'), false)
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'activity.json'), 'utf8')).transcriptIndex, { session: { lines: 1, at: 0 } })
    assert.deepEqual(readFileSync(join(home, 'transcripts', 'session.jsonl'), 'utf8').trim().split('\n').map(JSON.parse), state.transcripts.session)
    assert.deepEqual(rt.transcriptOf('session'), state.transcripts.session)
    assert.deepEqual(JSON.parse(readFileSync(join(home, `state.v${version}.json`), 'utf8')), state)
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
    await host.dispose()
    host = boot(home)
    await host.runtime
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')), saved, 'restart does not write again')
  } finally { await host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('a reader leaves retired data on disk until it takes the state lock', async () => {
  await withHost(async ({ runtime, home, dispose }) => {
    const writer = await runtime
    await writer.save()
    const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    saved.workflows = { old: {} }
    await dispose()
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
    } finally { await reader.dispose() }
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

test('transcripts migrate to JSONL, preserve broken files and release persisted rows', async () => {
  await withHost(async ({ runtime, home }) => {
    const rt = await runtime
    const folder = join(home, 'transcripts')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'read.json'), JSON.stringify([{ who: 'user', text: 'old', at: 5 }]))
    writeFileSync(join(folder, 'broken.json'), 'not json')
    const line = rt.appendLine('kept', { who: 'user', text: 'hello' })
    assert.deepEqual(rt.transcriptOf('read'), [{ who: 'user', text: 'old', at: 5 }])
    assert.deepEqual(rt.transcriptOf('broken'), [])
    assert.equal(readFileSync(join(folder, 'broken.json'), 'utf8'), 'not json', 'an unreadable legacy transcript stays unchanged')
    await rt.save()
    const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    assert.equal(Object.hasOwn(saved, 'transcripts'), false)
    assert.equal(Object.hasOwn(saved, 'transcriptIndex'), false)
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'activity.json'), 'utf8')).transcriptIndex.kept, { lines: 1, at: line.at })
    assert.deepEqual(readFileSync(join(folder, 'kept.jsonl'), 'utf8').trim().split('\n').map(JSON.parse), [line])
    assert.ok(Object.values(rt.state.transcripts).every(lines => lines.length === 0))
    assert.deepEqual(rt.transcriptInfo('read'), { lines: 1, at: 5 })
    assert.equal(existsSync(join(folder, 'read.json.bak')), true)
    const next = rt.appendLine('kept', { who: 'agent', text: 'new row' })
    await rt.save()
    assert.deepEqual(readFileSync(join(folder, 'kept.jsonl'), 'utf8').trim().split('\n').map(JSON.parse), [line, next])
  })
})
