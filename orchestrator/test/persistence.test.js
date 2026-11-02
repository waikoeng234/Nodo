import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot, until, withHost } from './helpers/host.js'

const rows = path => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)

test('JSONL appends preserve the prefix, restart content, and bounded resident history', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nodo-jsonl-'))
  let host = boot(home)
  try {
    let rt = await host.runtime
    const first = rt.appendLine('s', { text: 'one' })
    await rt.save()
    const path = join(home, 'transcripts', 's.jsonl')
    const prefix = readFileSync(path, 'utf8')
    const second = rt.appendLine('s', { text: 'two' })
    await rt.save()
    assert.equal(readFileSync(path, 'utf8'), prefix + JSON.stringify(second) + '\n')
    assert.equal(rt.state.transcripts.s.length, 0)
    await host.dispose()
    host = boot(home)
    rt = await host.runtime
    assert.deepEqual(rt.transcriptOf('s'), [first, second])
    assert.deepEqual(rt.transcriptInfo('s'), { lines: 2, at: second.at })
  } finally { await host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('JSONL compacts past TRANSCRIPT_MAX on load, and an idle write only once it doubles', async () => {
  await withHost(async ({ home, runtime }) => {
    const rt = await runtime
    mkdirSync(join(home, 'transcripts'), { recursive: true })
    const path = join(home, 'transcripts', 's.jsonl')
    const source = Array.from({ length: 850 }, (_, i) => ({ at: i, text: String(i) }))
    writeFileSync(path, source.map(line => JSON.stringify(line) + '\n').join(''))
    assert.deepEqual(rt.transcriptOf('s'), source.slice(-800))
    assert.deepEqual(rows(path), source.slice(-800))
    const old = rt.transcriptDelta('s')
    for (let i = 0; i < 20; i++) rt.appendLine('s', { text: `new ${i}` })
    await rt.save()
    assert.equal(rows(path).length, 820, 'a write below twice the limit only appends')
    const expected = rows(path).slice(-800)
    assert.deepEqual(rt.transcriptOf('s'), expected)
    const delta = rt.transcriptDelta('s', { token: old.token, n: old.base + 799, dirty: old.dirty })
    assert.deepEqual(delta.appended.map(item => item.line), expected.slice(-20))
    for (let i = 0; i < 781; i++) rt.appendLine('s', { text: `more ${i}` })
    await rt.save()
    assert.equal(rows(path).length, 800)
    assert.deepEqual(rt.transcriptOf('s'), rows(path))
  })
})

test('a killed JSONL writer loses only its incomplete last row and can append again', async () => {
  await withHost(async ({ home, runtime }) => {
    const rt = await runtime
    mkdirSync(join(home, 'transcripts'), { recursive: true })
    const path = join(home, 'transcripts', 's.jsonl')
    const child = spawn(process.execPath, ['-e', `
      const fs = require('node:fs')
      fs.writeFileSync(process.argv[1], '{"text":"完整"}\\n')
      fs.appendFileSync(process.argv[1], Buffer.from('{"text":"未完成').subarray(0, 17))
      process.send('half-written')
      setInterval(() => {}, 1000)
    `, path], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    await once(child, 'message')
    child.kill('SIGKILL')
    await once(child, 'exit')
    assert.deepEqual(rt.transcriptOf('s'), [{ text: '完整' }])
    const next = rt.appendLine('s', { text: 'next' })
    await rt.save()
    assert.deepEqual(rows(path), [{ text: '完整' }, next])
  })
})

test('a read-only host follows complete appends without a structural state rewrite', async () => {
  await withHost(async ({ runtime, home }) => {
    const writer = await runtime
    await until(() => writer.state.probe)
    writer.appendLine('s', { text: 'first' })
    await writer.save()
    const stateText = readFileSync(join(home, 'state.json'), 'utf8')
    const reader = spawn(process.execPath, ['--input-type=module', '-e', `
      import { boot } from ${JSON.stringify(new URL('./helpers/host.js', import.meta.url).href)}
      const host = boot(process.argv[1])
      const rt = await host.runtime
      process.on('message', async command => {
        if (command === 'close') { await host.dispose(); process.exit(0) }
        await rt.refresh()
        process.send({ readOnly: rt.readOnly(), lines: rt.transcriptOf('s'), versions: rt.versions() })
      })
      process.send('ready')
    `, home], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    await once(reader, 'message')
    const read = async () => { reader.send('read'); return (await once(reader, 'message'))[0] }
    try {
      const first = await read()
      assert.ok(first.readOnly)
      assert.equal(first.lines.length, 1)
      const before = first.versions
      writer.appendLine('s', { text: 'second' })
      await writer.save(true, true)
      const second = await read()
      assert.equal(second.versions.struct, before.struct)
      assert.ok(second.versions.activity > before.activity)
      assert.equal(readFileSync(join(home, 'state.json'), 'utf8'), stateText)
      assert.deepEqual(second.lines.map(line => line.text), ['first', 'second'])
      const path = join(home, 'transcripts', 's.jsonl')
      appendFileSync(path, '{"text":"half')
      assert.deepEqual((await read()).lines.map(line => line.text), ['first', 'second'])
      assert.ok(readFileSync(path, 'utf8').endsWith('half'), 'the reader does not repair a writer’s partial row')
      appendFileSync(path, '"}\n')
      assert.deepEqual((await read()).lines.map(line => line.text), ['first', 'second', 'half'])
      writer.driverSink('s', { type: 'turn/start', turnId: 't' })
      writer.driverSink('s', { type: 'delta', turnId: 't', text: 'running' })
      await until(() => existsSync(join(home, 'transcripts', 's.open')) && readFileSync(join(home, 'transcripts', 's.open'), 'utf8').includes('running'))
      const live = await read()
      assert.equal(live.lines.at(-1).text, 'running', 'the reader sees the running turn from its journal')
      assert.equal(live.versions.struct, before.struct)
    } finally { reader.send('close'); await once(reader, 'exit') }
  })
})

test('legacy JSON migrates lazily with an exact backup; broken input is preserved and logged', async () => {
  const warnings = []
  await withHost(async ({ runtime, home }) => {
    const rt = await runtime
    mkdirSync(join(home, 'transcripts'), { recursive: true })
    const old = join(home, 'transcripts', 'old.json')
    const source = '[\n {"text":"old","at":4}\n]'
    writeFileSync(old, source)
    assert.equal(existsSync(old + 'l'), false)
    assert.deepEqual(rt.transcriptOf('old'), [{ text: 'old', at: 4 }])
    assert.equal(existsSync(old), false)
    assert.equal(readFileSync(old + '.bak', 'utf8'), source)
    const broken = join(home, 'transcripts', 'bad.json')
    writeFileSync(broken, '[invalid')
    assert.deepEqual(rt.transcriptOf('bad'), [])
    assert.equal(readFileSync(broken, 'utf8'), '[invalid')
    assert.equal(existsSync(broken + 'l'), false)
    assert.ok(warnings.some(args => args.some(arg => String(arg).includes(`${broken}:`))), 'the log names the unreadable file')
  }, { logger: { warn: (...args) => warnings.push(args) } })
})

test('an unreadable or unwritable transcript does not hold back other saves', async () => {
  await withHost(async ({ runtime, home }) => {
    const rt = await runtime
    const dir = join(home, 'transcripts')
    mkdirSync(dir, { recursive: true })
    const corrupt = '{"text":"kept"}\nnot json\n'
    writeFileSync(join(dir, 'bad.jsonl'), corrupt)
    writeFileSync(join(dir, 'old.json'), '[invalid')
    rt.appendLine('bad', { text: 'after bad' })
    rt.appendLine('old', { text: 'after old' })
    rt.appendLine('good', { text: 'good' })
    rt.state.prefs.marker = 1
    await rt.save()
    assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).prefs.marker, 1)
    assert.deepEqual(rows(join(dir, 'good.jsonl')).map(line => line.text), ['good'])
    assert.deepEqual(rows(join(dir, 'bad.jsonl')).map(line => line.text), ['after bad'])
    const aside = readdirSync(dir).find(name => name.startsWith('bad.jsonl.broken-'))
    assert.equal(readFileSync(join(dir, aside), 'utf8'), corrupt)
    assert.equal(readFileSync(join(dir, 'old.json'), 'utf8'), '[invalid')
    assert.deepEqual(rows(join(dir, 'old.jsonl')).map(line => line.text), ['after old'])

    rt.appendLine('stuck', { text: 'waits' })
    mkdirSync(join(dir, 'stuck.jsonl'))
    rt.appendLine('good', { text: 'still saved' })
    rt.state.prefs.marker = 2
    await assert.rejects(rt.save(), { code: 'EISDIR' })
    assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).prefs.marker, 2)
    assert.deepEqual(rows(join(dir, 'good.jsonl')).map(line => line.text), ['good', 'still saved'])
    assert.deepEqual(rt.state.transcripts.stuck.map(line => line.text), ['waits'], 'the failed rows stay for the next write')
    rmSync(join(dir, 'stuck.jsonl'), { recursive: true })
    await rt.save()
    assert.deepEqual(rows(join(dir, 'stuck.jsonl')).map(line => line.text), ['waits'])
  })
})

test('a running turn is journaled, so a killed host keeps its rows', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nodo-journal-'))
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { existsSync, readFileSync } from 'node:fs'
      import { join } from 'node:path'
      import { boot, until } from ${JSON.stringify(new URL('./helpers/host.js', import.meta.url).href)}
      const home = process.argv[1]
      const rt = await boot(home).runtime
      rt.driverSink('s', { type: 'turn/start', turnId: 't' })
      rt.driverSink('s', { type: 'delta', turnId: 't', text: 'hello' })
      const open = join(home, 'transcripts', 's.open')
      await until(() => existsSync(open) && readFileSync(open, 'utf8').includes('hello'))
      process.send({ lines: rt.transcriptOf('s'), active: rt.workView().s?.active, jsonl: existsSync(join(home, 'transcripts', 's.jsonl')) })
      setInterval(() => {}, 1000)
    `, home], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    const [sent] = await once(child, 'message')
    child.kill('SIGKILL')
    await once(child, 'exit')
    assert.equal(sent.active, true)
    assert.equal(sent.jsonl, false, 'rows still changing are not settled')
    const host = boot(home)
    try {
      const rt = await host.runtime
      const recovered = rt.transcriptOf('s')
      assert.ok(recovered.some(line => line.text === 'hello'))
      assert.deepEqual(recovered, sent.lines)
      assert.deepEqual(rows(join(home, 'transcripts', 's.jsonl')), sent.lines)
      assert.equal(existsSync(join(home, 'transcripts', 's.open')), false)
    } finally { await host.dispose() }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('retired state fields are backed up and activity is stored separately without indentation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nodo-retired-'))
  const source = JSON.stringify({ version: 3, adapterSessions: { old: 1 }, streamDetails: { old: 2 },
    prefs: { keep: true }, stats: { s: { turns: 2 } }, transcriptIndex: { s: { lines: 1, at: 4 } } }, null, 2)
  writeFileSync(join(home, 'state.json'), source)
  const host = boot(home)
  try {
    const rt = await host.runtime
    assert.equal(readFileSync(join(home, 'state.retired.json.bak'), 'utf8'), source)
    const text = readFileSync(join(home, 'state.json'), 'utf8')
    assert.equal(text.includes('\n'), false)
    for (const key of ['adapterSessions', 'streamDetails', 'stats', 'transcriptIndex']) assert.equal(Object.hasOwn(JSON.parse(text), key), false)
    assert.equal(Object.hasOwn(rt.state, 'adapterSessions'), false)
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'activity.json'), 'utf8')), { stats: { s: { turns: 2 } }, transcriptIndex: { s: { lines: 1, at: 4 } }, streamDetails: { old: 2 } })
  } finally { await host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('running saves are coalesced; turn completion and shutdown flush the mutable rows', async () => {
  await withHost(async host => {
    const rt = await host.runtime
    await rt.save()
    const before = readFileSync(join(host.home, 'state.json'), 'utf8')
    rt.driverSink('s', { type: 'turn/start', turnId: 't' })
    rt.driverSink('s', { type: 'delta', turnId: 't', text: 'hello' })
    const saves = []
    for (let i = 0; i < 100; i++) { rt.state.prefs.marker = i; saves.push(rt.save()) }
    assert.equal(readFileSync(join(host.home, 'state.json'), 'utf8'), before)
    assert.equal(existsSync(join(host.home, 'transcripts', 's.jsonl')), false)
    await until(() => JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).prefs.marker === 99)
    await Promise.all(saves)
    assert.equal(existsSync(join(host.home, 'transcripts', 's.jsonl')), false, 'mutable rows are not settled during the turn')
    assert.ok(readFileSync(join(host.home, 'transcripts', 's.open'), 'utf8').includes('hello'), 'they are journaled instead')
    rt.driverSink('s', { type: 'turn/end', turnId: 't', reason: 'completed' })
    await until(() => !rt.workView().s?.active)
    assert.equal(rows(join(host.home, 'transcripts', 's.jsonl')).find(line => line.text === 'hello')?.open, false)
    rt.appendLine('shutdown', { text: 'last pending row', open: true })
    await rt.save(true)
    await host.dispose()
    assert.equal(rows(join(host.home, 'transcripts', 'shutdown.jsonl'))[0].text, 'last pending row')
  })
})

test('an answer acknowledged after turn completion is persisted before its request row becomes final', async () => {
  await withHost(async ({ runtime, home }) => {
    const rt = await runtime
    rt.driverSink('s', { type: 'turn/start', turnId: 't' })
    rt.driverSink('s', { type: 'request/opened', id: 'permission', kind: 'permission', tool: 'bash' })
    let accept
    rt.answerRequest = () => new Promise(resolve => { accept = resolve })
    const answering = rt.answerApproval('permission', { decision: 'allow' })
    await until(() => accept)
    rt.driverSink('s', { type: 'turn/end', turnId: 't', reason: 'done' })
    await until(() => !rt.workView().s?.active)
    assert.ok(rt.state.transcripts.s.some(line => line.requestId === 'permission'), 'the in-flight answer keeps the row mutable')
    accept(true)
    await answering
    await rt.save(false, true)
    const answer = rows(join(home, 'transcripts', 's.jsonl')).find(line => line.phase === 'end' && line.requestId === 'permission')
    assert.equal(answer.response.decision, 'allow')
    assert.equal(answer.cancelled, undefined)
  })
})
