import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializeHandoff } from '../core/src/workflow-materials.js'
import { install as installPrompt } from '../core/src/prompt.js'

const withMaterials = async work => {
  const home = mkdtempSync(join(tmpdir(), 'orch-materials-'))
  const cwd = join(home, 'workspace')
  mkdirSync(cwd)
  const run = { id: randomUUID(), snapshot: { graph: { nodes: [{ id: 'work', kind: 'agent', name: 'Writer' }] } }, tasks: {}, artifacts: {} }
  const history = []
  const add = (text, fields = {}) => {
    const task = { id: randomUUID(), nodeId: 'work', output: randomUUID() }
    run.tasks[task.id] = task
    run.artifacts[task.output] = { id: task.output, text, ...fields }
    history.unshift(task)
    return task
  }
  const args = { run, task: { id: randomUUID(), current: randomUUID() }, history, cwd, redact: text => text.replaceAll('PRIVATE_VALUE', '[REDACTED]') }
  try { await work({ home, cwd, run, history, add, args }) }
  finally { rmSync(home, { recursive: true, force: true }) }
}

test('long reports and many revisions stay complete on disk while the prompt gets only the latest pointer and an index', async () => withMaterials(async ({ cwd, add, args }) => {
  const older = add('# Earlier\nDo not repeat PRIVATE_VALUE\nNEXT: revise')
  for (let n = 0; n < 60; n++) add(`# Revision ${n}\n${'Details '.repeat(100)}`)
  const text = `# Latest\n${'Long report '.repeat(20_000)}\n## Evidence\nTAIL_END\nNEXT: approve`
  const newest = add(text)
  const materials = await materializeHandoff(args)
  assert.ok(materials.report.path.startsWith(join(realpathSync(cwd), '.nodo', 'workflow-runs', args.run.id)))
  assert.equal(readFileSync(materials.report.path, 'utf8'), text)
  assert.equal(readFileSync(join(cwd, '.nodo', '.gitignore'), 'utf8'), '*\n')
  const index = readFileSync(materials.index, 'utf8')
  assert.match(index, /Line 3: "## Evidence"/)
  assert.ok(index.includes(older.output))
  assert.ok(index.includes(newest.output))
  assert.match(index, /Latest on this path: false/)
  const oldPath = join(realpathSync(cwd), '.nodo', 'workflow-runs', args.run.id, `${older.output}.md`)
  assert.equal(readFileSync(oldPath, 'utf8'), '# Earlier\nDo not repeat [REDACTED]\nNEXT: revise')
  const rt = {}
  installPrompt(rt)
  const prompt = rt.renderHandoff({ workflowName: 'Long', stepName: 'Review', index: 2, of: 3, task: 'Check it', artifacts: [], materials })
  assert.ok(prompt.length < 3000)
  assert.equal(prompt.includes('Long report'), false)
  assert.equal(prompt.includes('Revision 59'), false)
  assert.equal(prompt.includes('NEXT: approve'), false)
}))

test('copies are local to each receiving workspace, survive completion and can be restored from the saved report', async () => withMaterials(async ({ home, add, args }) => {
  add('Retained report')
  const first = await materializeHandoff(args)
  const other = join(home, 'other')
  const second = await materializeHandoff({ ...args, cwd: other })
  assert.ok(second.report.path.startsWith(realpathSync(other)))
  assert.notEqual(first.report.path, second.report.path)
  args.run.status = 'done'
  assert.equal(readFileSync(first.report.path, 'utf8'), 'Retained report')
  rmSync(second.report.path)
  await materializeHandoff({ ...args, cwd: other })
  assert.equal(readFileSync(second.report.path, 'utf8'), 'Retained report')
  chmodSync(second.report.path, 0o600)
  writeFileSync(second.report.path, 'Changed copy')
  await materializeHandoff({ ...args, cwd: other })
  assert.equal(readFileSync(second.report.path, 'utf8'), 'Retained report')
}))

test('old truncated reports are labelled and each dispatch keeps its own index snapshot', async () => withMaterials(async ({ add, args }) => {
  add('Old partial report', { truncated: true })
  const old = await materializeHandoff(args)
  assert.equal(old.report.truncated, true)
  const snapshot = readFileSync(old.index, 'utf8')
  add('New complete report')
  const next = await materializeHandoff({ ...args, task: { id: randomUUID(), current: randomUUID() } })
  assert.notEqual(old.index, next.index)
  assert.equal(readFileSync(old.index, 'utf8'), snapshot)
  assert.equal(next.report.truncated, false)
}))

test('material export refuses directory escapes, invalid ids and symlink report files', async () => withMaterials(async ({ home, cwd, add, args }) => {
  add('Report')
  const outside = join(home, 'outside')
  mkdirSync(outside)
  symlinkSync(outside, join(cwd, '.nodo'))
  await assert.rejects(materializeHandoff(args), /must stay inside their workspace/)
  rmSync(join(cwd, '.nodo'))
  const materials = await materializeHandoff(args)
  const target = join(outside, 'unchanged.md')
  writeFileSync(target, 'Keep me')
  rmSync(materials.report.path)
  symlinkSync(target, materials.report.path)
  await assert.rejects(materializeHandoff(args), /must be a regular file/)
  assert.equal(readFileSync(target, 'utf8'), 'Keep me')
  await assert.rejects(materializeHandoff({ ...args, run: { ...args.run, id: '../escape' } }), /Invalid workflow material id/)
}))
