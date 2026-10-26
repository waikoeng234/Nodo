import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'
import { replacementEdit } from '../agent-drivers/dist/file-changes.js'

const nodes = node => !node || typeof node !== 'object' ? [] : [node,
  ...[...(node.children ?? []), node.props?.children].flat(Infinity).flatMap(nodes)]
const find = (tree, className) => nodes(tree).find(node => node.props.className === className)

test('replacement fragments display their scope and relative line numbers without merging separate edits', async () => {
  const { CodeDiff } = await loadClient('code-diff.tsx')
  const tree = CodeDiff({ filename: 'x', patch: replacementEdit('x', 'before\n', 'after\n').diffText })
  assert.ok(find(tree, 'nodo-code-diff-filename').children.includes(' · 替换片段'))
  const lines = nodes(tree).filter(node => node.props?.['data-kind'] === 'meta')
  assert.match(lines[0].children.join(''), /片段内/)
  assert.equal(find(tree, 'nodo-code-diff-counts').props['aria-label'], '新增 1 行，删除 1 行')
  const { summarizeChanges } = await loadClient('file-diffs.ts')
  const summary = summarizeChanges({ scope: 'edit-tools', fileCount: 1, files: [{ path: 'x', edits: [
    replacementEdit('x', 'before\n', 'after\n'), replacementEdit('x', 'after\n', 'before\n'),
  ] }] })
  assert.deepEqual({ ...summary.totals }, { added: 2, removed: 2 })
})

test('code diff uses host totals and preserves native diff controls and all source whitespace', async () => {
  const received = []
  const { CodeDiff } = await loadClient('code-diff.tsx', { primitives: {
    diffTotals: diffs => { received.push(diffs); return { added: 2, removed: 1 } },
  } })
  const diff = { path: 'src/composer.tsx', oldText: '\tconst old = 1;\n\n', newText: '\tconst draft = 2;  \n  next();\n\n' }
  const tree = CodeDiff({ filename: diff.path, diff, cycle: 4 })
  assert.equal(tree.props['data-slot'], 'code-diff')
  assert.equal(find(tree, 'nodo-code-diff-filename').props.title, diff.path)
  assert.equal(find(tree, 'nodo-code-diff-counts').props['aria-label'], '新增 2 行，删除 1 行')
  const native = nodes(tree).find(node => node.type === 'DiffBlock')
  assert.equal(native.props.diffs[0], diff, 'the host receives the complete original data')
  assert.equal(received[0][0], diff, 'the same data is used for counts and rendering')
  assert.equal(native.props.key, 4)
  assert.equal(native.props.labels.copy, '复制')
  assert.equal(native.props.labels.expandAria(25), '展开其余 25 行')
  assert.equal(native.props.labels.collapse, '收起')
  assert.ok(!native.props.maxLines, 'the native collapsed context behavior is retained')
})

test('empty files and unchanged files retain zero counts, and source revisions replay the entrance', async () => {
  const { CodeDiff } = await loadClient('code-diff.tsx', { primitives: {
    diffTotals: () => ({ added: 0, removed: 0 }),
  } })
  for (const text of ['', 'unchanged\n']) {
    const props = { filename: 'empty.ts', diff: { path: 'empty.ts', oldText: text, newText: text } }
    const tree = CodeDiff({ ...props, cycle: 1 })
    assert.deepEqual(find(tree, 'nodo-code-diff-added').children, ['+', 0])
    assert.deepEqual(find(tree, 'nodo-code-diff-removed').children, ['−', 0])
    assert.equal(nodes(tree).find(node => node.type === 'DiffBlock').props.key, 1)
    assert.equal(nodes(CodeDiff({ ...props, cycle: 2 })).find(node => node.type === 'DiffBlock').props.key, 2)
  }
})

test('unified patches display original changed lines, accurate counts and copy the complete source patch', async () => {
  const copied = []
  const { CodeDiff } = await loadClient('code-diff.tsx', { primitives: {
    diffTotals: () => { throw new Error('patches must not be treated as full before and after images') },
    writeClipboard: async text => { copied.push(text); return true },
  } })
  const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -8 +8 @@\n-old\n+<script>alert(1)</script>\n\\ No newline at end of file\n'
  const tree = CodeDiff({ filename: '<img>.ts', patch })
  assert.equal(find(tree, 'nodo-code-diff-filename').children[0], '<img>.ts')
  assert.equal(find(tree, 'nodo-code-diff-counts').props['aria-label'], '新增 1 行，删除 1 行')
  const rows = nodes(tree).filter(node => node.props.className === 'nodo-code-diff-line')
  assert.ok(rows.some(row => row.props['data-kind'] === 'added' && row.children[0] === '+<script>alert(1)</script>'))
  assert.ok(rows.some(row => row.props['data-kind'] === 'removed' && row.children[0] === '-old'))
  await find(tree, 'nodo-code-diff-copy').props.onClick()
  assert.deepEqual(copied, [patch])
  assert.ok(!nodes(tree).some(node => node.type === 'script' || node.props.dangerouslySetInnerHTML))
  assert.equal(CodeDiff({ filename: 'unknown.ts' }), null)
})

test('unsupported and truncated patches retain the raw code fallback without guessed counts', async () => {
  const { CodeDiff } = await loadClient('code-diff.tsx')
  for (const patch of ['@@ original patch', '@@ -1,2 +1 @@\n-a\n+b\n']) {
    const tree = CodeDiff({ filename: 'file.ts', patch })
    assert.ok(!find(tree, 'nodo-code-diff-counts'))
    const code = nodes(tree).find(node => node.type === 'CodeBlock')
    assert.equal(code.props.code, patch)
    assert.equal(code.props.lang, 'diff')
  }
})

test('structured calls render each file separately and preserve terminal output and detail loading', async () => {
  const { StreamRecordCard, CodeDiff } = await loadClient(['stream-records.js', 'code-diff.tsx'])
  const diffs = [
    { path: 'same.ts', oldText: 'before\n', newText: 'after\n' },
    { path: 'same.ts', oldText: 'after\n', newText: 'after again\n' },
    { path: 'new.ts', oldText: null, newText: 'created\n', created: true },
    { path: 'unknown.ts', oldText: null, newText: 'known after\n' },
  ]
  const before = JSON.stringify(diffs)
  const tree = StreamRecordCard({ record: { version: 1, kind: 'tool', runId: 'r', entityId: 't', revision: 8,
    title: 'Bash', status: 'done', capture: 'complete', body: { command: 'edit files', outputText: 'source output', diffs },
    details: { state: 'stored', ref: 'saved-ref' } }, request: { profile: 'p', session: 's' } })
  const cards = nodes(tree).filter(node => node.type === CodeDiff)
  assert.deepEqual(cards.map(card => card.props.filename), ['same.ts', 'same.ts', 'new.ts'])
  assert.deepEqual(cards.map(card => card.props.key), [0, 1, 2], 'separate edits to one file remain separate cards')
  assert.ok(cards.every(card => card.props.cycle === 8))
  assert.equal(cards[2].props.diff.oldText, null)
  assert.equal(nodes(tree).find(node => node.type === 'TerminalBlock').props.output, 'source output')
  assert.ok(nodes(tree).some(node => node.type === 'Button' && node.children.includes('查看完整详情')))
  assert.equal(JSON.stringify(diffs), before)
})

test('file edits distinguish confirmed creation, deletion, unknown before-images and raw patches', async () => {
  const { ChangedFile, CodeDiff } = await loadClient(['stream-records.js', 'code-diff.tsx'])
  const file = { path: '/ws/src/x.ts', edits: [
    { operation: 'add', oldText: null, newText: 'created\n' },
    { operation: 'delete', oldText: 'deleted\n', newText: '' },
    { operation: 'update', oldText: 'old\n', newText: 'new\n' },
    { operation: 'update', newText: 'known after only\n' },
    { operation: 'update', diffText: '@@ -1 +1 @@\n-before\n+after\n' },
    { operation: 'unknown', availability: 'binary' },
  ] }
  const tree = ChangedFile({ file, loaded: true, root: '/ws', cycle: 3 })
  const cards = nodes(tree).filter(node => node.type === CodeDiff)
  assert.equal(cards.length, 4)
  assert.ok(cards.every(card => card.props.filename === 'src/x.ts' && card.props.cycle === 3))
  assert.equal(cards[0].props.diff.oldText, null)
  assert.equal(cards[1].props.diff.newText, '')
  assert.equal(cards[2].props.diff.oldText, 'old\n')
  assert.equal(cards[3].props.patch, file.edits[4].diffText)
  assert.equal(cards[3].props.diff, undefined)
  assert.ok(nodes(tree).some(node => node.type === 'CodeBlock' && node.props.code === 'known after only\n'))
  assert.match(JSON.stringify(tree), /来源未提供修改前内容/)
  assert.match(JSON.stringify(tree), /二进制文件/)
})

test('turn patches preserve current-file access and revision metadata in the production summary', async () => {
  const { StreamRecordCard, FileChangesSummary, ChangedFile, CodeDiff } = await loadClient(['stream-records.js', 'code-diff.tsx', 'file-changes-summary.tsx'])
  const record = { runId: 'r', entityId: 'e', revision: 12, body: { scope: 'workspace-snapshot', cwd: '/ws', fileCount: 1,
    files: [{ path: '/ws/x', edits: [] }], turnDiff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b' } }
  const request = { profile: 'p', session: 's' }
  const tree = StreamRecordCard({ record: { ...record, kind: 'changes' }, request })
  assert.equal(tree.type, FileChangesSummary)
  const file = tree.props.renderFile(record.body.files[0], record.body.turnDiff)
  assert.equal(file.type, ChangedFile)
  assert.equal(file.props.request, request)
  assert.equal(file.props.cycle, 12)
  const detail = ChangedFile(file.props)
  const patch = nodes(detail).find(node => node.type === CodeDiff)
  assert.equal(patch.props.filename, 'x')
  assert.equal(patch.props.patch, record.body.turnDiff)
  assert.equal(patch.props.cycle, 12)
  assert.ok(nodes(detail).some(node => node.type === 'Button' && node.children.includes('查看当前内容')))
})

test('large patches render a bounded preview with explicit expansion while copying the complete source', async () => {
  const copied = []
  const { CodeDiff, host } = await loadClient('code-diff.tsx', { primitives: {
    writeClipboard: async text => { copied.push(text); return true },
  } })
  const patch = `--- a/x\n+++ b/x\n@@ -0,0 +1,1000 @@\n${Array.from({ length: 1000 }, (_, i) => `+line ${i}`).join('\n')}\n`
  const props = { filename: 'x', patch }
  const render = () => { host.reset(); return CodeDiff(props) }
  const rows = tree => nodes(tree).filter(node => node.props.className === 'nodo-code-diff-line')
  let tree = render()
  assert.equal(rows(tree).length, 200)
  assert.equal(find(tree, 'nodo-code-diff-counts').props['aria-label'], '新增 1000 行，删除 0 行')
  assert.equal(find(tree, 'nodo-code-diff-expand').props['aria-expanded'], false)
  await find(tree, 'nodo-code-diff-copy').props.onClick()
  assert.deepEqual(copied, [patch])
  find(tree, 'nodo-code-diff-expand').props.onClick()
  tree = render()
  assert.equal(rows(tree).length, 1001)
  find(tree, 'nodo-code-diff-expand').props.onClick()
  assert.equal(rows(render()).length, 200)
})
