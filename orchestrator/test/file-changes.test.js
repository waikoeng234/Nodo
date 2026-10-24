import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDriver, registerEngine } from '../agent-drivers/dist/index.js'
import { createFileChanges, normalizeChanges, CHANGE_LIMITS } from '../agent-drivers/dist/file-changes.js'
import { claudeFileChanges } from '../agent-drivers/dist/claude/file-changes.js'
import { changesTool, createRecordTracker, previewRecord } from '../core/src/stream-records.js'
import { boot, until } from './helpers/host.js'

const edit = (newText = 'after') => ({ path: 'x', edit: { operation: 'update', oldText: 'before', newText } })
const withDriver = async (engine, run) => {
  const cwd = mkdtempSync(join(tmpdir(), 'nodo-es05-driver-'))
  const bin = join(cwd, engine)
  copyFileSync(new URL(`./fixtures/${engine === 'opencode' ? 'opencode-flow-cli' : engine + '-cli'}.cjs`, import.meta.url), bin)
  chmodSync(bin, 0o755)
  const events = []
  const driver = createDriver(engine, { bin, cwd, onEvent: event => events.push(event) })
  try { await run({ cwd, bin, driver, events }) }
  finally { driver.dispose(); rmSync(cwd, { recursive: true, force: true }) }
}

test('confirmed file changes keep unique paths and per-edit evidence without inventing a net diff', () => {
  const changes = createFileChanges('/workspace')
  changes.add('a', [edit()], true)
  changes.add('a', [edit('duplicate')], true)
  changes.add('b', [edit('before')], true)
  changes.add('failed', [{ ...edit(), path: 'failed' }], false)
  const snapshot = changes.snapshot('turn')
  assert.equal(snapshot.presentation.body.fileCount, 1)
  assert.equal(snapshot.presentation.body.files[0].edits.length, 2)
  assert.equal(snapshot.presentation.body.coverage, 'partial')
  assert.equal(snapshot.presentation.body.files[0].path, '/workspace/x')
  assert.equal(snapshot.presentation.body.files[0].edits[1].newText, 'before')
  assert.equal(normalizeChanges({ scope: 'edit-tools', coverage: 'partial', files: [{ path: 'x', edits: [{ operation: 'update', oldText: null, newText: 'unknown before' }] }] }), null)
})

test('changes budgets retain bounded identities, flag truncation and replace whole turn diff snapshots', () => {
  const changes = createFileChanges('/workspace')
  changes.add('large', [{ path: 'x', edit: { operation: 'update', diffText: 'x'.repeat(CHANGE_LIMITS.bytes + 1) } }], true)
  changes.diff('old'); changes.diff('new')
  const snapshot = changes.snapshot('turn').presentation
  assert.equal(snapshot.capture, 'partial')
  assert.equal(snapshot.body.files[0].edits[0].diffText, undefined)
  assert.equal(snapshot.body.turnDiff, 'new')
  for (let i = 0; i < CHANGE_LIMITS.files + 5; i++) changes.add('id' + i, [{ ...edit(), path: 'p' + i }], true)
  assert.equal(changes.snapshot('turn').presentation.body.files.length, CHANGE_LIMITS.files)
})

for (const engine of ['codex', 'opencode']) test(`${engine} actual driver maps confirmed protocol edits, excluding foreign, failed and duplicate results`, async () => {
  await withDriver(engine, async ({ cwd, driver, events }) => {
    writeFileSync(join(cwd, 'unrelated-workspace-file.txt'), 'external writer')
    await driver.sendTurn('FILES_FLOW')
    await until(() => events.some(event => event.type === 'turn/end'))
    const updates = events.filter(event => event.type === 'changes')
    assert.equal(updates.length, 1)
    const body = updates[0].presentation.body
    assert.equal(body.fileCount, 10)
    assert.equal(body.coverage, 'partial')
    assert.ok(body.files.some(file => file.path.endsWith('/.agent/tmp/proof.md')))
    assert.ok(body.files.some(file => file.path === '/tmp/nodo-outside-proof.md'))
    assert.ok(!body.files.some(file => /failed|foreign|unrelated/.test(file.path)))
    assert.equal(body.files.find(file => file.path.endsWith('一.md')).edits.length, 2)
    if (engine === 'codex') {
      assert.equal(body.turnDiff, 'ES05_FINAL_TURN_DIFF')
      assert.equal(events.find(event => event.callId === 'failed' && event.phase === 'end').isError, true)
    }
    else {
      assert.deepEqual(events.find(event => event.callId === 'file-edit' && event.phase === 'end').output, { text: 'ES05_RAW_OUTPUT' })
      assert.equal(body.files.find(file => file.path.endsWith('/.agent/tmp/proof.md')).edits[1].oldText, undefined)
    }
    const record = createRecordTracker({ engine, profileId: 'p', conversationId: 's' }).accept(changesTool(updates[0]))
    const preview = previewRecord(record)
    assert.equal(preview.kind, 'changes')
    assert.equal(preview.body.fileCount, 10)
    assert.equal(preview.body.files.length, 3)
    assert.equal(preview.body.files[0].edits[0].newText, undefined)
    assert.ok(JSON.stringify(preview).length <= 16000)
    events.length = 0
    await driver.sendTurn('EMPTY')
    await until(() => events.some(event => event.type === 'turn/end'))
    assert.equal(events.find(event => event.type === 'changes').presentation.body.fileCount, 0)
    assert.equal(events.find(event => event.type === 'changes').presentation.body.coverage, 'partial')
  })
})

test('OpenCode keeps edit kind across partial updates and accepts confirmed locations without diff text', async () => {
  await withDriver('opencode', async ({ driver, events }) => {
    await driver.sendTurn('FILE_LOCATIONS')
    await until(() => events.some(event => event.type === 'turn/end'))
    const body = events.find(event => event.type === 'changes').presentation.body
    assert.equal(body.fileCount, 10)
    assert.ok(body.files.every(file => file.path.includes('/location-') && file.edits[0].operation === 'unknown'))
    assert.ok(body.files.every(file => file.edits[0].oldText === undefined && file.edits[0].newText === undefined))
    assert.deepEqual(body.files[0].edits[1], { operation: 'add', oldText: null, newText: 'created' })
  })
})

for (const engine of ['claude', 'zcode']) test(`${engine} pairs confirmed edit results without counting failure, replay, foreign or shell writes`, async () => {
  await withDriver(engine, async ({ driver, events }) => {
    await driver.sendTurn('FILES_FLOW')
    await until(() => events.some(event => event.type === 'turn/end'))
    const snapshots = events.filter(event => event.type === 'changes')
    assert.equal(snapshots.length, 1)
    const body = snapshots[0].presentation.body
    assert.equal(body.fileCount, 10)
    assert.equal(body.coverage, 'partial')
    assert.ok(body.files.every(file => file.path.includes('/.agent/文件 ')))
    assert.ok(body.files.every(file => file.edits.length === 1))
    if (engine === 'claude') {
      assert.equal(body.files[0].edits[0].newText, 'confirmed 0')
      assert.equal(body.files[0].edits[0].oldText, undefined)
      assert.equal(body.files[1].edits[0].oldText, null)
    } else assert.ok(body.files.every(file => file.edits[0].newText === undefined))
    events.length = 0
    await driver.sendTurn('EMPTY')
    await until(() => events.some(event => event.type === 'turn/end'))
    assert.equal(events.find(event => event.type === 'changes').presentation.body.fileCount, 0)
  })
})

test('Claude structured edit output never promotes replacement snippets to whole-file before/after', () => {
  const input = { file_path: '/x', old_string: 'a', new_string: 'b' }
  const result = { filePath: '/x', oldString: 'a', newString: 'b', originalFile: 'a full file', gitDiff: { patch: 'source patch' } }
  assert.deepEqual(claudeFileChanges('Edit', input, result), [{ path: '/x', edit: { operation: 'update', diffText: 'source patch' } }])
  assert.deepEqual(claudeFileChanges('Edit', input, { ...result, staged: true }), [])
  assert.deepEqual(claudeFileChanges('NotebookEdit', { notebook_path: '/x' }, { notebook_path: '/x', original_file: 'before notebook', updated_file: 'after notebook' }),
    [{ path: '/x', edit: { operation: 'update', oldText: 'before notebook', newText: 'after notebook' } }])
})

test('Codex malformed future file payloads downgrade capture without breaking the engine turn', async () => {
  await withDriver('codex', async ({ driver, events }) => {
    await driver.sendTurn('FILES_MALFORMED')
    await until(() => events.some(event => event.type === 'turn/end'))
    assert.equal(events.find(event => event.type === 'turn/end').reason, 'done')
    const snapshot = events.find(event => event.type === 'changes').presentation
    assert.equal(snapshot.capture, 'partial')
    assert.equal(snapshot.body.fileCount, 0)
  })
})

test('two legacy conversations preserve independent summaries and immutable details across restart and deletion', async () => {
  await withDriver('opencode', async ({ cwd, bin }) => {
    registerEngine('es05-legacy', { info: { id: 'es05-legacy', label: 'Changes fixture', requiresCwd: true }, validate: value => value,
      create: options => createDriver('opencode', { ...options, bin }) })
    const home = join(cwd, 'nodo')
    let host = boot(home)
    try {
      const workspace = await host.api('workspace-create', { name: 'Shared', cwd })
      const a = await host.api('profile-create', { name: 'A', engine: 'es05-legacy', workspace: workspace.id })
      const b = await host.api('profile-create', { name: 'B', engine: 'es05-legacy', workspace: workspace.id })
      await Promise.all([host.api('send', { profile: a.id, text: 'FILES_FLOW' }), host.api('send', { profile: b.id, text: 'EMPTY' })])
      await until(async () => { const state = await host.api('state'); return !state.work[a.id].active && !state.work[b.id].active })
      const ar = (await host.api('transcript', { profile: a.id })).find(line => line.kind === 'changes').presentation
      const br = (await host.api('transcript', { profile: b.id })).find(line => line.kind === 'changes').presentation
      assert.equal(ar.body.fileCount, 10); assert.equal(br.body.fileCount, 0)
      assert.notEqual(ar.runId, br.runId)
      const full = await host.api('stream-detail', { profile: a.id, ref: ar.details.ref })
      assert.equal(full.body.files.length, 10)
      await assert.rejects(host.api('stream-detail', { profile: b.id, ref: ar.details.ref }), /不属于此会话/)
      host.dispose(); host = boot(home)
      assert.deepEqual(await host.api('stream-detail', { profile: a.id, ref: ar.details.ref }), full)
      await host.api('profile-delete', { id: a.id })
      await assert.rejects(host.api('stream-detail', { profile: a.id, ref: ar.details.ref }), /不可用/)
    } finally { host.dispose() }
  })
})
