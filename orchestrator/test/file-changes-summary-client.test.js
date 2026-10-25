import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const nodes = node => !node || typeof node !== 'object' ? [] : [node,
  ...[...(node.children ?? []), node.props?.children].flat(Infinity).flatMap(nodes)]
const find = (tree, className) => nodes(tree).find(node => node.props.className === className)
const patch = '@@ -1 +1,2 @@\n-old\n+new\n+extra\n'
const file = path => ({ path, edits: [{ operation: 'update', diffText: patch }] })
const record = files => ({ version: 1, kind: 'changes', mode: 'snapshot', runId: 'r', entityId: 'c', revision: 1,
  status: 'done', capture: 'complete', truncated: false,
  body: { scope: 'edit-tools', coverage: 'partial', cwd: '/ws', fileCount: files.length, files } })

test('summary counts validated patch lines, excluding headers, and prefers the source turn diff for net stats', async () => {
  const { summarizeChanges, parsedPatch, patchCounts } = await loadClient('file-diffs.ts')
  assert.deepEqual(JSON.parse(JSON.stringify(patchCounts(parsedPatch(patch)))), { added: 2, removed: 1 })
  const body = { ...record([file('/ws/x.ts')]).body,
    turnDiff: 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+net\n' }
  const summary = summarizeChanges(body)
  assert.deepEqual(JSON.parse(JSON.stringify(summary.totals)), { added: 1, removed: 1 })
  assert.match(summary.files[0].patch, /\+net/)
  assert.doesNotMatch(summary.files[0].patch, /\+extra/)
  const special = parsedPatch('--- a/x\n+++ b/x\n@@ -1 +1 @@\n--- payload\n+++ payload\n')
  assert.deepEqual(JSON.parse(JSON.stringify(patchCounts(special))), { added: 1, removed: 1 }, 'hunk payload resembling file headers is counted')
  assert.equal(parsedPatch('@@ -1,2 +1 @@\n-old\n+new\n'), null)
})

test('chained before and after images produce a net change and missing evidence never becomes zero', async () => {
  const { summarizeChanges } = await loadClient('file-diffs.ts')
  const chained = { path: '/ws/x', edits: [
    { operation: 'update', oldText: 'first\n', newText: 'middle\n' },
    { operation: 'update', oldText: 'middle\n', newText: 'last\n' },
  ] }
  assert.deepEqual(JSON.parse(JSON.stringify(summarizeChanges(record([chained]).body).totals)), { added: 1, removed: 1 })
  for (const edits of [[], [{ operation: 'update', newText: 'unknown before' }], [{ operation: 'unknown', availability: 'binary' }],
    [{ operation: 'update', diffText: '@@ unsupported' }]]) {
    assert.equal(summarizeChanges(record([{ path: 'x', edits }]).body).totals, undefined)
  }
  const preview = record([file('x')]).body
  preview.fileCount = 10
  assert.equal(summarizeChanges(preview).totals, undefined, 'three preview files cannot stand for ten source files')
})

test('summary card shows three file rows, expands the rest, and opens selected or all Code Diff details', async () => {
  const { FileChangesSummary, CodeDiff, host } = await loadClient(['file-changes-summary.tsx', 'code-diff.tsx'])
  const source = record(Array.from({ length: 5 }, (_, index) => file(`/ws/src/${index}.ts`)))
  const renderFile = value => ({ type: 'file-detail', props: { path: value.path }, children: [] })
  const props = { record: source, value: source, full: source, load: async () => source, renderFile }
  const render = () => { host.reset(); return FileChangesSummary(props) }
  let tree = render()
  assert.equal(find(tree, 'nodo-changes-title').children[0], '已编辑')
  assert.equal(nodes(tree).filter(node => node.props.className === 'nodo-changes-file').length, 3)
  assert.deepEqual(find(tree, 'nodo-changes-path').children, ['src/0.ts'])
  assert.deepEqual(find(tree, 'nodo-changes-more').children.slice(0, 1), ['再显示 2 个文件'])
  assert.equal(find(tree, 'nodo-changes-view').props['aria-expanded'], false)
  assert.ok(!find(tree, 'nodo-changes-details'))
  await find(tree, 'nodo-changes-more').props.onClick()
  tree = render()
  assert.equal(nodes(tree).filter(node => node.props.className === 'nodo-changes-file').length, 5)
  await nodes(tree).filter(node => node.props.className === 'nodo-changes-file')[1].props.onClick()
  tree = render()
  assert.deepEqual(nodes(tree).filter(node => node.type === 'file-detail').map(node => node.props.path), ['/ws/src/1.ts'])
  const entries = nodes(tree).filter(node => node.props.className === 'nodo-changes-file-entry')
  assert.equal(entries[1].children[0].props.className, 'nodo-changes-file')
  assert.equal(entries[1].children[1].props.className, 'nodo-changes-details')
  assert.equal(entries[1].children[1].props.id, entries[1].children[0].props['aria-controls'])
  assert.equal(nodes(entries[1]).find(node => node.type === 'file-detail').props.path, '/ws/src/1.ts')
  assert.ok(entries.filter((_, index) => index !== 1).every(entry => !find(entry, 'nodo-changes-details')))
  assert.equal(find(tree, 'nodo-changes-files').props.id, find(tree, 'nodo-changes-view').props['aria-controls'])
  await find(tree, 'nodo-changes-view').props.onClick()
  tree = render()
  assert.equal(nodes(tree).filter(node => node.type === 'file-detail').length, 5)
  assert.ok(nodes(tree).filter(node => node.props.className === 'nodo-changes-file-entry')
    .every(entry => entry.children[1]?.props.className === 'nodo-changes-details'))
  assert.equal(find(tree, 'nodo-changes-view').props['aria-expanded'], true)
  assert.ok(!nodes(tree).some(node => node.type === CodeDiff), 'the caller renders each source edit without a duplicate diff')
  await find(tree, 'nodo-changes-view').props.onClick()
  assert.ok(!find(render(), 'nodo-changes-details'))
})

test('switching or collapsing a file keeps its diff next to that row and folding the list closes hidden selections', async () => {
  const { FileChangesSummary, host } = await loadClient('file-changes-summary.tsx')
  const source = record(Array.from({ length: 5 }, (_, index) => file(`/ws/${index}.ts`)))
  const props = { record: source, value: source, full: source, load: async () => source,
    renderFile: value => ({ type: 'file-detail', props: { path: value.path }, children: [] }) }
  const render = () => { host.reset(); return FileChangesSummary(props) }
  const rows = tree => nodes(tree).filter(node => node.props.className === 'nodo-changes-file')
  let tree = render()
  await rows(tree)[0].props.onClick()
  tree = render()
  await rows(tree)[2].props.onClick()
  tree = render()
  assert.deepEqual(nodes(tree).filter(node => node.type === 'file-detail').map(node => node.props.path), ['/ws/2.ts'])
  await rows(tree)[2].props.onClick()
  tree = render()
  assert.ok(!find(tree, 'nodo-changes-details'))
  await find(tree, 'nodo-changes-view').props.onClick()
  tree = render()
  assert.equal(rows(tree).length, 5, 'view all reveals every file and puts each diff under its own row')
  await rows(tree)[4].props.onClick()
  tree = render()
  assert.deepEqual(nodes(tree).filter(node => node.type === 'file-detail').map(node => node.props.path), ['/ws/4.ts'])
  await find(tree, 'nodo-changes-more').props.onClick()
  tree = render()
  assert.equal(rows(tree).length, 3)
  assert.ok(!find(tree, 'nodo-changes-details'))
  await find(tree, 'nodo-changes-more').props.onClick()
  assert.ok(!find(render(), 'nodo-changes-details'), 'a hidden selection does not reopen on later expansion')
})

test('a full source turn patch is used for file details and workspace snapshots keep their attribution', async () => {
  const { FileChangesSummary, CodeDiff, host } = await loadClient(['file-changes-summary.tsx', 'code-diff.tsx'])
  const source = record([file('/ws/x.ts')])
  source.body.scope = 'workspace-snapshot'
  source.body.turnDiff = '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+net\n'
  const props = { record: source, value: source, full: source, load: async () => source,
    renderFile: (file, patch) => ({ type: CodeDiff, props: { filename: file.path.slice(4), patch }, children: [] }) }
  let tree = FileChangesSummary(props)
  assert.equal(find(tree, 'nodo-changes-title').children[0], '工作区变更')
  assert.match(find(tree, 'nodo-changes-coverage').props.title, /可能包含其他会话或进程/)
  await find(tree, 'nodo-changes-view').props.onClick()
  host.reset()
  tree = FileChangesSummary(props)
  const diff = nodes(tree).find(node => node.type === CodeDiff)
  assert.equal(diff.props.filename, 'x.ts')
  assert.match(diff.props.patch, /\+net/)
})

test('preview cards load saved details only when visible, disconnect observers, and expose failure and retry states', async () => {
  let observation, disconnected = 0, loads = 0
  const { FileChangesSummary, host } = await loadClient('file-changes-summary.tsx', { globals: {
    IntersectionObserver: class {
      constructor(callback) { observation = callback }
      observe() {}
      disconnect() { disconnected++ }
    },
  } })
  const source = { ...record([file('x')]), truncated: true }
  const props = { record: source, value: source, full: null, available: true, load: async () => { loads++; return null }, renderFile: () => null }
  let tree = FileChangesSummary(props)
  const cleanup = host.effects[1]()
  assert.equal(loads, 0)
  observation([{ isIntersecting: false }])
  assert.equal(loads, 0)
  observation([{ isIntersecting: true }])
  assert.equal(loads, 1)
  assert.equal(disconnected, 1)
  cleanup()
  assert.equal(disconnected, 2)
  await find(tree, 'nodo-changes-view').props.onClick()
  assert.equal(loads, 2)
  host.reset()
  tree = FileChangesSummary({ ...props, error: '详情版本不匹配' })
  assert.ok(!find(tree, 'nodo-changes-details'))
  assert.equal(nodes(tree).find(node => node.props.role === 'alert').children[0], '详情版本不匹配')
  host.reset()
  assert.equal(find(FileChangesSummary({ ...props, busy: true }), 'nodo-changes-view').props.disabled, true)
})

test('loading missing preview files precedes expansion, and source limits remain visible without inventing entries', async () => {
  const { FileChangesSummary, host } = await loadClient('file-changes-summary.tsx')
  const complete = record(Array.from({ length: 10 }, (_, index) => file(`file-${index}`)))
  const preview = { ...complete, truncated: true, body: { ...complete.body, files: complete.body.files.slice(0, 3) } }
  let loads = 0
  const props = { record: preview, value: preview, full: null, available: true, load: async () => { loads++; return complete }, renderFile: () => null }
  let tree = FileChangesSummary(props)
  await find(tree, 'nodo-changes-more').props.onClick()
  assert.equal(loads, 1)
  host.reset()
  tree = FileChangesSummary({ ...props, value: complete, full: complete })
  assert.equal(nodes(tree).filter(node => node.props.className === 'nodo-changes-file').length, 10)
  host.reset()
  tree = FileChangesSummary({ ...props, value: preview, full: preview, available: false })
  assert.equal(find(tree, 'nodo-changes-notice').children.join(''), '仅保存 3 / 10 个文件')
  assert.equal(nodes(tree).filter(node => node.props.className === 'nodo-changes-file').length, 3)
})
