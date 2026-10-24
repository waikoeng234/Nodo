import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { install } from '../core/src/runs.js'
import { redactDeep, redactor } from '../core/src/secrets.js'
import { RUN_LIMITS } from '../core/src/constants.js'
import { workflowSessionTitle } from '../core/shared/task-titles.js'

const store = (home, readOnly = () => undefined) => {
  const rt = {
    home,
    ctx: { effect() {} },
    readOnly,
    loadSecrets: async () => {},
    redactDeepSecrets: value => redactDeep(value, text => text.replaceAll('sk-live-123', '[ORCH_SECRET_KEY]')),
  }
  install(rt)
  return rt
}

const withHome = async (run) => {
  const home = mkdtempSync(join(tmpdir(), 'orch-runs-test-'))
  try { await run(home) } finally { rmSync(home, { recursive: true, force: true }) }
}

const fileOf = (home, id) => JSON.parse(readFileSync(join(home, 'runs', `${id}.json`), 'utf8'))

test('a run is created, committed and read back from its own file', async () => withHome(async (home) => {
  const rt = store(home)
  const run = await rt.createRun({ workflowId: 'w1', workflowName: 'Draft', graph: { nodes: [], edges: [] } })
  assert.equal(run.status, 'running')
  assert.deepEqual(run.snapshot.limits, RUN_LIMITS)
  const next = await rt.commit(run.id, (draft, event) => {
    draft.tasks.t1 = { id: 't1', nodeId: 's1', status: 'pending' }
    event('task/create', { taskId: 't1' })
  })
  assert.equal(next.revision, 2)
  assert.deepEqual(fileOf(home, run.id).tasks.t1.status, 'pending')
  assert.deepEqual(fileOf(home, run.id).events.map(e => e.type), ['run/status', 'task/create'])
  assert.deepEqual(readdirSync(join(home, 'runs')), [`${run.id}.json`])

  const reopened = store(home)
  assert.equal((await reopened.loadRun(run.id)).tasks.t1.nodeId, 's1')
  assert.deepEqual((await reopened.listRuns()).map(r => [r.id, r.status, r.workflowName]), [[run.id, 'running', 'Draft']])
}))

test('a failed write rejects the commit and keeps the last committed run', async () => withHome(async (home) => {
  const rt = store(home)
  const run = await rt.createRun({ workflowId: 'w1', workflowName: 'Draft', graph: {} })
  rmSync(join(home, 'runs', `${run.id}.json`))
  mkdirSync(join(home, 'runs', `${run.id}.json`, 'blocker'), { recursive: true })
  await assert.rejects(rt.commit(run.id, (draft) => { draft.status = 'done' }))
  const kept = await rt.loadRun(run.id)
  assert.equal(kept.status, 'running')
  assert.equal(kept.revision, 1)
  assert.deepEqual(readdirSync(join(home, 'runs')), [`${run.id}.json`])
}))

test('a mutation that throws writes nothing', async () => withHome(async (home) => {
  const rt = store(home)
  const run = await rt.createRun({ workflowId: 'w1', workflowName: 'Draft', graph: {} })
  await assert.rejects(rt.commit(run.id, (draft) => { draft.status = 'done'; throw new Error('stop') }), /stop/)
  assert.equal(fileOf(home, run.id).status, 'running')
  assert.equal((await rt.loadRun(run.id)).revision, 1)
}))

test('commits to one run apply in order', async () => withHome(async (home) => {
  const rt = store(home)
  const run = await rt.createRun({ workflowId: 'w1', workflowName: 'Draft', graph: {} })
  await Promise.all(['a', 'b', 'c'].map(key => rt.commit(run.id, (draft) => { draft.tasks[key] = { id: key } })))
  const saved = fileOf(home, run.id)
  assert.equal(saved.revision, 4)
  assert.deepEqual(Object.keys(saved.tasks), ['a', 'b', 'c'])
}))

test('a read-only host refuses to write runs', async () => withHome(async (home) => {
  const rt = store(home, () => 'open in another dsh')
  await assert.rejects(rt.createRun({ workflowId: 'w1', workflowName: 'Draft', graph: {} }), { code: 'orch/read-only' })
  assert.deepEqual(await rt.listRuns(), [])
}))

test('events beyond the limit drop the oldest and are counted', async () => withHome(async (home) => {
  const rt = store(home)
  const run = await rt.createRun({ workflowId: 'w1', workflowName: 'Draft', graph: {}, limits: { eventsMax: 3 } })
  await rt.commit(run.id, (_draft, event) => { for (let n = 0; n < 4; n++) event('task/status') })
  const saved = fileOf(home, run.id)
  assert.deepEqual(saved.events.map(e => e.seq), [3, 4, 5])
  assert.equal(saved.eventsDropped, 2)
}))

test('the snapshot is redacted before it is written', async () => withHome(async (home) => {
  const rt = store(home)
  const run = await rt.createRun({ workflowId: 'w1', workflowName: 'Draft', graph: {}, profiles: { p1: { name: 'Writer', instructions: 'use sk-live-123' } } })
  assert.equal(fileOf(home, run.id).snapshot.profiles.p1.instructions, 'use [ORCH_SECRET_KEY]')
  assert.doesNotMatch(readFileSync(join(home, 'runs', `${run.id}.json`), 'utf8'), /sk-live-123/)
}))

test('an unreadable run file is listed as unreadable and cannot be committed', async () => withHome(async (home) => {
  const rt = store(home)
  const id = '00000000-0000-4000-8000-000000000000'
  mkdirSync(join(home, 'runs'), { recursive: true })
  writeFileSync(join(home, 'runs', `${id}.json`), '{ broken')
  assert.deepEqual((await rt.listRuns()).map(r => [r.id, r.status]), [[id, 'unreadable']])
  await assert.rejects(rt.commit(id, () => {}), { code: 'orch/invalid' })
  assert.equal(readFileSync(join(home, 'runs', `${id}.json`), 'utf8'), '{ broken')
  await assert.rejects(rt.loadRun('../state'), { code: 'orch/not-found' })
}))

test('a parseable run file missing its records is unreadable and kept as it is', async () => withHome(async (home) => {
  const rt = store(home)
  const id = '00000000-0000-4000-8000-000000000001'
  const contents = JSON.stringify({ version: 1, id, status: 'running', revision: 1 })
  mkdirSync(join(home, 'runs'), { recursive: true })
  writeFileSync(join(home, 'runs', `${id}.json`), contents)
  assert.equal((await rt.loadRun(id)).status, 'unreadable')
  await assert.rejects(rt.commit(id, (draft) => { draft.status = 'done' }), { code: 'orch/invalid' })
  assert.equal(readFileSync(join(home, 'runs', `${id}.json`), 'utf8'), contents)
}))

test('task titles follow the entry wire, survive reload and remain separate from the flow name', async () => withHome(async home => {
  const rt = store(home)
  const graph = { nodes: [{ id: 'later', kind: 'agent', task: '审查上一步' }, { id: 'start', kind: 'start' },
    { id: 'first', kind: 'agent', task: '\n# 修复登录后白屏。保留现有行为\n更多细节' }],
  edges: [{ from: 'start', to: 'first' }, { from: 'first', to: 'later' }] }
  const run = await rt.createRun({ workflowId: 'w1', workflowName: '开发', graph })
  assert.equal(run.title, '修复登录后白屏')
  const custom = await rt.createRun({ workflowId: 'w1', workflowName: '开发', title: '  登录修复与验证  ', graph })
  const reopened = store(home)
  assert.equal((await reopened.loadRun(custom.id)).title, '登录修复与验证')
  assert.deepEqual((await reopened.listRuns()).map(item => [item.workflowName, item.title]).sort(),
    [['开发', '修复登录后白屏'], ['开发', '登录修复与验证']].sort())
  const path = join(home, 'runs', `${run.id}.json`), legacy = fileOf(home, run.id)
  delete legacy.title
  writeFileSync(path, JSON.stringify(legacy))
  const before = readFileSync(path, 'utf8')
  assert.equal((await store(home).listRuns()).find(item => item.id === run.id).title, '修复登录后白屏')
  assert.equal(readFileSync(path, 'utf8'), before, 'reading an old run does not migrate its file')
}))

test('titles handle attachments, redact secrets and reject invalid explicit titles before writing', async () => withHome(async home => {
  const rt = store(home), graph = { nodes: [{ id: 'start', kind: 'start' }, { id: 'work', kind: 'agent', files: [{ name: 'requirements.pdf' }] }], edges: [{ from: 'start', to: 'work' }] }
  const attached = await rt.createRun({ workflowName: '流程', graph })
  assert.equal(attached.title, 'requirements.pdf')
  const secret = await rt.createRun({ workflowName: '流程', title: 'Check sk-live-123', graph })
  assert.equal(secret.title, 'Check [ORCH_SECRET_KEY]')
  graph.nodes[1].task = 'Check sk-live-123'
  const automatic = await rt.createRun({ workflowName: '流程', graph })
  assert.equal(automatic.title, 'Check [ORCH_SECRET_KEY]')
  for (const title of ['', '   ', 123, {}, 'a'.repeat(81)]) await assert.rejects(rt.createRun({ graph, title }), { code: 'orch/invalid' })
  assert.equal((await rt.listRuns()).length, 3)
}))

test('relative and generic session tasks carry the run topic without changing concrete tasks', () => {
  for (const task of ['根据上面的报告复核', '看一下前面的结果', '检查之前的产出', '验证刚才的修改', '复核前文', '审查前述结果', '阅读该报告',
    '请复核一下', '检查一下', 'Check the above', 'Review earlier findings', 'Please review', 'check it']) {
    assert.equal(workflowSessionTitle({ task }, '登录修复'), `登录修复 · ${task}`, task)
  }
  for (const task of ['修复登录失败', '实现报告导出', 'Review login changes', 'Check earlierVersion compatibility', 'Test aboveboard naming']) {
    assert.equal(workflowSessionTitle({ task }, '登录修复'), task, task)
  }
})

test('session title sources are redacted before first-line, sentence and length extraction', () => {
  const value = 'synthetic-title-credential-that-crosses-the-forty-character-boundary'
  const redact = redactor([{ name: 'TITLE', value }])
  for (const node of [{ task: `Check ${value}` }, { question: `Check ${value}` },
    { task: '', files: [{ name: `Check ${value}.txt` }] }, { images: [{ name: `Check ${value}.png` }] }]) {
    assert.equal(workflowSessionTitle(node, 'Topic', redact), `Check [secret:TITLE]${node.files ? '.txt' : node.images ? '.png' : ''}`)
  }
  const topic = `${'t'.repeat(35)} ${value}`
  assert.equal(workflowSessionTitle({ task: '请复核一下' }, topic, redact), `${redact(topic).slice(0, 40)} · 请复核一下`)
  const relative = { task: `根据上面报告 ${'t'.repeat(24)} ${value}` }
  const combined = workflowSessionTitle(relative, `${'t'.repeat(37)} ${value}`, redact)
  assert.equal(combined.length, 80)
  assert.equal(combined.includes(value.slice(0, 8)), false, 'the final 80-character cut cannot expose a credential prefix')
  for (const value of ['synthetic\nmultiline-credential', 'synthetic。sentence-credential']) {
    assert.equal(workflowSessionTitle({ task: `Check ${value}` }, 'Topic', redactor([{ name: 'TITLE', value }])), 'Check [secret:TITLE]')
  }
})

test('explicit run titles redact whitespace-bearing secrets before normalizing their whitespace', async () => withHome(async home => {
  const rt = store(home)
  for (const value of ['synthetic  spaced-credential', 'synthetic\nmultiline-credential', '  synthetic-padded-credential  ']) {
    rt.redactDeepSecrets = valueToRedact => redactDeep(valueToRedact, redactor([{ name: 'WHITESPACE', value }]))
    const run = await rt.createRun({ graph: {}, title: `  Check ${value} now  ` })
    assert.equal(run.title, 'Check [secret:WHITESPACE] now')
    assert.equal(fileOf(home, run.id).title, run.title)
  }
}))

test('title normalization cannot synthesize a stored credential before either title length boundary', async () => withHome(async home => {
  const rt = store(home)
  for (const value of ['synthetic normalized credential', 'synthetic normalized credential-that-crosses-the-forty-character-boundary']) {
    const redact = redactor([{ name: 'NORMALIZED', value }]), task = `Check ${value.replace(' ', '  ')}`
    rt.redactDeepSecrets = value => redactDeep(value, redact)
    const graph = { nodes: [{ id: 'start', kind: 'start' }, { id: 'work', kind: 'agent', task }], edges: [{ from: 'start', to: 'work' }] }
    const auto = await rt.createRun({ graph }), explicit = await rt.createRun({ graph, title: task })
    for (const run of [auto, explicit]) assert.equal(fileOf(home, run.id).title, 'Check [secret:NORMALIZED]')
    assert.equal(workflowSessionTitle({ task }, 'Topic', redact), 'Check [secret:NORMALIZED]')
    assert.equal((await rt.listRuns()).find(run => run.id === auto.id).title, 'Check [secret:NORMALIZED]')
  }
}))

test('warm and cold summaries redact current secrets and reconstruct automatic and legacy titles without migrating files', async () => withHome(async home => {
  const rt = store(home), value = 'synthetic-cached-title-credential-crossing-the-forty-character-boundary'
  let redact = text => text
  rt.redactDeepSecrets = value => redactDeep(value, redact)
  const graph = { nodes: [{ id: 'start', kind: 'start' }, { id: 'work', kind: 'agent', task: `Check ${value}` }], edges: [{ from: 'start', to: 'work' }] }
  const auto = await rt.createRun({ graph, workflowName: `Flow ${value}` })
  const chosen = await rt.createRun({ graph, title: 'A deliberately chosen topic' })
  const explicitSecret = await rt.createRun({ graph, title: `Check ${value}` })
  const legacy = await rt.createRun({ graph })
  const path = join(home, 'runs', `${legacy.id}.json`), old = fileOf(home, legacy.id)
  delete old.title
  writeFileSync(path, JSON.stringify(old))
  const reopened = store(home)
  reopened.redactDeepSecrets = value => redactDeep(value, text => redact(text))
  await reopened.listRuns()
  await rt.listRuns()
  const before = new Map([auto, chosen, explicitSecret, legacy].map(run => [run.id, readFileSync(join(home, 'runs', `${run.id}.json`), 'utf8')]))
  redact = redactor([{ name: 'CURRENT', value }])
  for (const reader of [rt, reopened, Object.assign(store(home), { redactDeepSecrets: value => redactDeep(value, redact) })]) {
    const list = await reader.listRuns(), byId = id => list.find(run => run.id === id)
    assert.equal(byId(auto.id).title, 'Check [secret:CURRENT]')
    assert.equal(byId(auto.id).workflowName, 'Flow [secret:CURRENT]')
    assert.equal(byId(chosen.id).title, 'A deliberately chosen topic')
    assert.equal(byId(explicitSecret.id).title, 'Check [secret:CURRENT]')
    assert.equal(byId(legacy.id).title, 'Check [secret:CURRENT]')
    assert.equal(JSON.stringify(list).includes(value.slice(0, 25)), false)
  }
  for (const [id, contents] of before) assert.equal(readFileSync(join(home, 'runs', `${id}.json`), 'utf8'), contents)
  assert.deepEqual((await rt.loadRun(auto.id)).snapshot, auto.snapshot)
}))

test('list summaries stay current and isolated across successful and failed commits', async () => withHome(async home => {
  const rt = store(home)
  const first = await rt.createRun({ graph: {}, title: 'First' })
  const second = await rt.createRun({ graph: {}, title: 'Second' })
  await rt.commit(first.id, draft => { draft.createdAt = 1 })
  await rt.commit(second.id, draft => { draft.createdAt = 2; draft.status = 'done'; draft.endedAt = 3 })
  const list = await rt.listRuns()
  assert.deepEqual(list.map(run => [run.id, run.status, run.endedAt]), [[second.id, 'done', 3], [first.id, 'running', undefined]])
  list[0].title = 'Polluted'
  await assert.rejects(rt.commit(second.id, draft => { draft.title = 'Failed mutation'; throw new Error('stop') }), /stop/)
  assert.equal((await rt.listRuns())[0].title, 'Second')
  rmSync(join(home, 'runs', `${second.id}.json`))
  mkdirSync(join(home, 'runs', `${second.id}.json`, 'blocker'), { recursive: true })
  await assert.rejects(rt.commit(second.id, draft => { draft.status = 'failed' }))
  assert.equal((await rt.listRuns())[0].status, 'done', 'failed persistence keeps the last committed summary')
}))

test('listing cold reports parses once, clones only summaries and leaves full loads on demand', async t => withHome(async home => {
  const writer = store(home)
  const run = await writer.createRun({ graph: {}, title: 'Large report' })
  const marker = 'LARGE_REPORT_FOR_LIST_CACHE'
  await writer.commit(run.id, draft => { draft.artifacts.report = { text: marker.repeat(20_000) } })
  const rt = store(home)
  let parses = 0, fullClones = 0
  const parse = JSON.parse, clone = globalThis.structuredClone
  t.mock.method(JSON, 'parse', (...args) => { if (args[0].includes(marker)) parses++; return parse(...args) })
  t.mock.method(globalThis, 'structuredClone', value => { if (value?.artifacts?.report) fullClones++; return clone(value) })
  assert.equal((await rt.listRuns())[0].title, 'Large report')
  assert.equal(parses, 1)
  await rt.listRuns()
  assert.deepEqual([parses, fullClones], [1, 0], 'repeat lists neither reparse nor clone full reports')
  assert.equal((await rt.loadRun(run.id)).artifacts.report.text, marker.repeat(20_000))
  assert.deepEqual([parses, fullClones], [2, 1], 'listing did not retain the full run in the load cache')
  await rt.commit(run.id, draft => { draft.title = 'Updated'; draft.status = 'done' })
  assert.deepEqual((await rt.listRuns()).map(item => [item.title, item.status]), [['Updated', 'done']])
}))

test('an unreadable list entry is read again after its file is repaired', async () => withHome(async home => {
  const created = await store(home).createRun({ graph: {}, title: 'Repaired' })
  const path = join(home, 'runs', `${created.id}.json`), contents = readFileSync(path, 'utf8')
  writeFileSync(path, '{ broken')
  const rt = store(home)
  assert.equal((await rt.listRuns())[0].status, 'unreadable')
  writeFileSync(path, contents)
  assert.equal((await rt.listRuns())[0].title, 'Repaired')
}))

for (const unreadable of [false, true]) test(`a cold list read cannot replace a newer commit summary (${unreadable ? 'unreadable' : 'valid'} old file)`, async t => withHome(async home => {
  const created = await store(home).createRun({ graph: {}, title: 'Before' })
  const path = join(home, 'runs', `${created.id}.json`), contents = readFileSync(path, 'utf8')
  if (unreadable) writeFileSync(path, '{ broken')
  const rt = store(home), ready = Promise.withResolvers(), release = Promise.withResolvers()
  const read = fsPromises.readFile
  let held = false
  const mocked = t.mock.method(fsPromises, 'readFile', async (...args) => {
    const value = await read(...args)
    if (args[0] === path && !held) { held = true; ready.resolve(); await release.promise }
    return value
  })
  syncBuiltinESMExports()
  try {
    const pending = rt.listRuns()
    await ready.promise
    if (unreadable) writeFileSync(path, contents)
    await rt.commit(created.id, draft => { draft.title = 'After'; draft.status = 'done' })
    release.resolve()
    assert.deepEqual((await pending).map(run => [run.title, run.status]), [['After', 'done']])
    assert.equal((await rt.listRuns())[0].title, 'After')
  } finally {
    release.resolve()
    mocked.mock.restore()
    syncBuiltinESMExports()
  }
}))
