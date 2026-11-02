// Transcript positions: appended lines, in-place updates, truncation at the
// cap, and the fallback to a full answer when the client's position is unknown.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot, until, withHost } from './helpers/host.js'
import { homeLock } from '../core/src/home-lock.js'

test('transcript delta: appends, in-place updates, truncation, unknown positions', async () => {
  await withHost(async host => {
    const rt = await host.runtime
    const first = rt.appendLine('s', { who: 'user', kind: 'text', text: 'one' })
    const second = rt.appendLine('s', { who: 'agent', kind: 'text', text: 'two' })
    // Unknown position: full answer, lines numbered from 1.
    const full = rt.transcriptDelta('s', undefined)
    assert.equal(full.full, true)
    assert.deepEqual(full.lines.map(item => item.n), [1, 2])
    const position = { token: full.token, n: full.base + full.lines.length - 1, dirty: full.dirty }
    // A new append: only it comes back.
    const third = rt.appendLine('s', { who: 'agent', kind: 'text', text: 'three' })
    const appended = rt.transcriptDelta('s', position)
    assert.equal(appended.full, undefined)
    assert.deepEqual(appended.appended.map(item => item.n), [3])
    assert.deepEqual(appended.appended.map(item => item.line), [third])
    assert.deepEqual(appended.changed, [])
    // An in-place update (plan rows do this): the changed line comes back with
    // its number, and the object identity in memory is untouched.
    second.text = 'two changed'
    rt.touchLine('s', second)
    const changed = rt.transcriptDelta('s', appended && { token: appended.token, n: 3, dirty: appended.dirty })
    assert.deepEqual(changed.appended, [])
    assert.deepEqual(changed.changed.map(item => item.n), [2])
    assert.equal(changed.changed[0].line.text, 'two changed')
    assert.equal(changed.changed[0].line, second)
    // The position the delta answered is what the client would hold next.
    const next = { token: changed.token, n: changed.base + 2, dirty: changed.dirty }
    assert.deepEqual(rt.transcriptDelta('s', next).appended, [])
    assert.deepEqual(rt.transcriptDelta('s', next).changed, [])
    // A position from another host life (token mismatch) or without a token falls back to full.
    assert.equal(rt.transcriptDelta('s', { ...next, token: 'other' }).full, true)
    assert.equal(rt.transcriptDelta('s', { n: 3, dirty: 0 }).full, true)
    // A position older than the truncation window falls back to full.
    for (let index = 0; index < 850; index++) rt.appendLine('s', { who: 'agent', kind: 'text', text: `fill ${index}` })
    assert.equal(rt.state.transcripts.s.length, 800, 'the transcript is capped')
    assert.equal(rt.transcriptDelta('s', position).full, true, 'a position below the base is unknown')
    const fresh = rt.transcriptDelta('s', undefined)
    assert.equal(fresh.lines.length, rt.state.transcripts.s.length)
    assert.equal(fresh.lines[0].n, fresh.base)
    // Appends after the full answer carry only the new lines.
    const extra = rt.appendLine('s', { who: 'agent', kind: 'text', text: 'tail' })
    const tail = rt.transcriptDelta('s', { token: fresh.token, n: fresh.base + fresh.lines.length - 1, dirty: fresh.dirty })
    assert.deepEqual(tail.appended.map(item => item.line), [extra])
  })
})

test('activity saves move the activity count but not the structure version', async () => {
  await withHost(async host => {
    const rt = await host.runtime
    const before = rt.versions()
    const line = rt.appendLine('s', { who: 'user', kind: 'text', text: 'hi' })
    await rt.save(true)
    const afterActivity = rt.versions()
    assert.equal(afterActivity.struct, before.struct, 'content-only saves leave the structure version')
    assert.ok(afterActivity.activity > before.activity)
    await rt.save()
    const afterStruct = rt.versions()
    assert.ok(afterStruct.struct > afterActivity.struct)
    assert.deepEqual(rt.transcriptOf('s'), [line])
  })
})

test('another host taking the lock is noticed through the directory watcher', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nodo-live-lock-'))
  const writer = boot(home)
  try {
    const rt = await writer.runtime
    await rt.save()
    assert.equal(rt.readOnly(), undefined)
    writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: 999999, host: 'other', boot: 1, token: 'theirs', since: Date.now() }))
    await until(() => rt.readOnly() !== undefined)
    assert.ok(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')))
  } finally { await writer.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('a watched lock answers ownership from memory; strict checks and unwatched locks read the file', () => {
  const home = mkdtempSync(join(tmpdir(), 'nodo-lock-'))
  let watched = true
  const lock = homeLock(join(home, 'state.lock'), { watched: () => watched })
  try {
    assert.equal(lock.claim(), undefined)
    writeFileSync(join(home, 'state.lock'), JSON.stringify({ host: 'other', token: 'theirs' }))
    assert.equal(lock.owns(), true, 'no file read while watched')
    assert.equal(lock.owns(true), false, 'a strict check reads the file')
    assert.equal(lock.owns(), false, 'and the loss is kept')
    rmSync(join(home, 'state.lock'))
    assert.equal(lock.claim(), undefined)
    writeFileSync(join(home, 'state.lock'), JSON.stringify({ host: 'other', token: 'theirs' }))
    watched = false
    assert.equal(lock.owns(), false, 'without a watcher every check reads the file')
  } finally { lock.release(); rmSync(home, { recursive: true, force: true }) }
})

test('a reader that reloads the writer\'s file moves both versions and renumbers transcripts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nodo-reader-'))
  const writer = boot(home)
  await (await writer.runtime).save()
  await writer.dispose()
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: 1, host: 'elsewhere', token: 'theirs', since: Date.now() }))
  const reader = boot(home)
  try {
    const rt = await reader.runtime
    const first = await reader.api('state')
    assert.notEqual(rt.readOnly(), undefined)
    const held = rt.transcriptDelta('s', undefined)
    const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    saved.prefs.marker = 'from the writer'
    writeFileSync(join(home, 'state.json'), JSON.stringify(saved, null, 2) + '\n')
    const next = await until(async () => {
      const answer = await reader.api('state', { since: { struct: first.struct } })
      return answer.unchanged ? undefined : answer
    })
    assert.equal(next.prefs.marker, 'from the writer')
    assert.notEqual(next.activity, first.activity, 'transcripts are pulled again')
    assert.equal(rt.transcriptDelta('s', { token: held.token, n: 0, dirty: held.dirty }).full, true, 'old positions are unknown after a reload')
  } finally { await reader.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('an archived session held only by dsh answers its lines once, then unchanged', async () => {
  await withHost(async host => {
    const rt = await host.runtime
    const workspace = await host.api('workspace-create', { name: 'Archive', cwd: join(host.home, 'ws') })
    const role = await host.api('profile-create', { name: 'Archived role', engine: 'echo' })
    const session = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true })
    rt.sessionsOf(rt.state.profiles[role.id]).find(item => item.id === session.id).archivedAt = Date.now()
    rt.readHostTranscript = async () => [{ who: 'agent', kind: 'text', text: 'from dsh' }]
    const first = await host.api('transcript', { profile: role.id, session: session.id, since: {} })
    assert.deepEqual(first, { archived: true, lines: [{ who: 'agent', kind: 'text', text: 'from dsh' }] })
    assert.deepEqual(await host.api('transcript', { profile: role.id, session: session.id, since: { archived: true } }), { unchanged: true })
  })
})

test('transcript delta: streamed text and tool output growing in place come back as changed', async () => {
  await withHost(async host => {
    const rt = await host.runtime
    rt.driverSink('p', { type: 'turn/start', turnId: 't' })
    rt.driverSink('p', { type: 'thinking', turnId: 't', text: 'The' })
    rt.driverSink('p', { type: 'delta', turnId: 't', text: '下面' })
    const full = rt.transcriptDelta('p', undefined)
    let position = { token: full.token, n: full.base + full.lines.length - 1, dirty: full.dirty }
    const pull = () => {
      const delta = rt.transcriptDelta('p', position)
      position = { token: delta.token, n: delta.base + rt.state.transcripts.p.length - 1, dirty: delta.dirty }
      return delta
    }
    rt.driverSink('p', { type: 'delta', turnId: 't', text: '是完整的回答' })
    assert.deepEqual(pull().changed.map(item => item.line.text), ['下面是完整的回答'])
    rt.driverSink('p', { type: 'tool', turnId: 't', callId: 'a', name: 'Bash', phase: 'start' })
    pull()
    rt.driverSink('p', { type: 'tool', turnId: 't', callId: 'a', phase: 'update', outputDelta: 'line 1\n' })
    assert.deepEqual(pull().changed.map(item => item.line.output), ['line 1\n'])
    rt.driverSink('p', { type: 'turn/end', turnId: 't', reason: 'completed' })
    const ended = pull()
    const reply = [...ended.changed, ...ended.appended].find(item => item.line.text === '下面是完整的回答')
    assert.equal(reply?.line.open, false, 'the closed reply row comes back')
    await rt.save(true)
  })
})
