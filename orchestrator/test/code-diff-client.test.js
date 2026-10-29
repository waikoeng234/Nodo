import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'
import { replacementEdit } from '../agent-drivers/dist/file-changes.js'

const nodes = node => !node || typeof node !== 'object' ? [] : [node,
  ...[...(node.children ?? []), node.props?.children].flat(Infinity).flatMap(nodes)]
const find = (tree, className) => nodes(tree).find(node => node.props.className === className)

test('filenames open the bound right panel and remain text without a target', async () => {
  const opened = [], listeners = new Set()
  let target = { workspace: 'project' }
  const { CodeDiff } = await loadClient('code-diff.tsx', { uiShared: {
    rightPanelService: {
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      getSnapshot: () => ({ target }), openFile: path => opened.push(path),
    },
  } })
  for (const filename of ['src/main.ts', '/workspace/src/main.ts', '/outside/file.ts']) {
    const name = find(CodeDiff({ filename, patch: 'raw' }), 'nodo-code-diff-filename')
    assert.equal(name.type, 'button')
    assert.equal(name.props['aria-label'], `预览文件 ${filename}`)
    name.props.onClick()
  }
  assert.deepEqual(opened, ['src/main.ts', '/workspace/src/main.ts', '/outside/file.ts'])
  const fragment = find(CodeDiff({ filename: 'x.ts', patch: replacementEdit('x.ts', 'before', 'after').diffText }), 'nodo-code-diff-filename')
  assert.equal(fragment.props['aria-label'], '预览文件 x.ts · 替换片段')
  const label = find(CodeDiff({ filename: '轮次差异', previewable: false, patch: 'raw' }), 'nodo-code-diff-filename')
  assert.equal(label.type, 'span')
  assert.equal(label.props.onClick, undefined)
  target = null
  const name = find(CodeDiff({ filename: 'main.ts', patch: 'raw' }), 'nodo-code-diff-filename')
  assert.equal(name.type, 'span')
  assert.equal(name.props.onClick, undefined)
})

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

test('turn patches preserve revision metadata in the production summary', async () => {
  const { StreamRecordCard, FileChangesSummary, ChangedFile, CodeDiff } = await loadClient(['stream-records.js', 'code-diff.tsx', 'file-changes-summary.tsx'])
  const record = { runId: 'r', entityId: 'e', revision: 12, body: { scope: 'workspace-snapshot', cwd: '/ws', fileCount: 1,
    files: [{ path: '/ws/x', edits: [] }], turnDiff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b' } }
  const request = { profile: 'p', session: 's' }
  const tree = StreamRecordCard({ record: { ...record, kind: 'changes' }, request })
  assert.equal(tree.type, FileChangesSummary)
  const file = tree.props.renderFile(record.body.files[0], record.body.turnDiff)
  assert.equal(file.type, ChangedFile)
  assert.equal(file.props.cycle, 12)
  const detail = ChangedFile(file.props)
  const patch = nodes(detail).find(node => node.type === CodeDiff)
  assert.equal(patch.props.filename, 'x')
  assert.equal(patch.props.patch, record.body.turnDiff)
  assert.equal(patch.props.cycle, 12)
  assert.ok(!nodes(detail).some(node => node.type === 'Button'))
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

test('panel diffs use one number column, highlight words, fold context and preserve wrapped text without changing native cards', async () => {
  const { CodeDiff, CODE_DIFF_CSS, host } = await loadClient('code-diff.tsx', { primitives: { diffTotals: () => ({ added: 1, removed: 1 }) } })
  const context = Array.from({ length: 31 }, (_, index) => `unchanged ${index}\n`).join('')
  const long = `const message = "${'long_payload_'.repeat(80)}";  `
  const props = { filename: 'x.ts', panel: true, diff: { path: 'x.ts', oldText: `${context}const old = 1;\n`, newText: `${context}${long}\n` } }
  const render = () => { host.reset(); const panel = CodeDiff(props); return panel.type(panel.props) }
  let tree = render()
  const gap = find(tree, 'nodo-panel-diff-gap')
  assert.equal(gap.type, 'button')
  assert.equal(gap.children.join(''), '25 行未修改')
  const lines = () => nodes(tree).filter(node => node.props.className === 'nodo-panel-diff-line')
  const removed = lines().find(node => node.props['data-kind'] === 'removed')
  const added = lines().find(node => node.props['data-kind'] === 'added')
  assert.deepEqual(removed.children[0].children, [32])
  assert.deepEqual(added.children[0].children, [32])
  assert.ok(lines().every(row => nodes(row).filter(node => node.props.className === 'nodo-panel-diff-number').length === 1))
  assert.ok(nodes(removed).some(node => node.type === 'mark'))
  const code = nodes(added).find(node => node.type === 'CodeBlock')
  assert.equal(code.props.code, long, 'syntax coloring preserves source whitespace')
  assert.equal(code.props.lang, 'ts')
  assert.equal(code.props.wrap, true)
  assert.equal(code.props.showHeader, false)
  const overlay = find(added, 'nodo-panel-diff-words')
  assert.equal(overlay.props['aria-hidden'], true)
  assert.equal(overlay.children.map(node => typeof node === 'string' ? node : node.children.join('')).join(''), long, 'word highlights use the exact same text as syntax coloring')
  assert.ok(nodes(added).some(node => node.type === 'mark'), 'changed words receive inline emphasis')
  gap.props.onClick()
  tree = render()
  assert.equal(lines().length, 33)
  assert.ok(!find(tree, 'nodo-panel-diff-gap'))
  assert.ok(!find(tree, 'nodo-code-diff-header'))
  assert.ok(!nodes(tree).some(node => node.type === 'DiffBlock' || node.children.includes('复制')))
  assert.match(CODE_DIFF_CSS, /\.nodo-panel-diff-text\{[^}]*white-space:pre-wrap;overflow-wrap:anywhere/)
  assert.match(CODE_DIFF_CSS, /\.nodo-panel-diff-line\{[^}]*grid-template-columns:calc\(4ch \+ 20px\) minmax\(0,1fr\)/)
  assert.match(CODE_DIFF_CSS, /\.nodo-panel-diff-gap\{[^}]*text-align:left/)
  assert.match(CODE_DIFF_CSS, /\.nodo-panel-diff-number\{[^}]*border-left:3px solid var\(--nodo-line-tone,transparent\)/)
  host.reset()
  assert.ok(nodes(CodeDiff({ ...props, panel: false })).some(node => node.type === 'DiffBlock'), 'cards still render the host primitive')
})

test('panel patch rows preserve hunk offsets, prefixes, fragment scope and raw fallback wrapping', async () => {
  const { CodeDiff, host } = await loadClient('code-diff.tsx')
  const render = props => { host.reset(); const panel = CodeDiff({ panel: true, filename: 'x.ts', ...props }); return panel.type(panel.props) }
  const tree = render({ patch: '@@ -8,2 +10,3 @@\n same\n-before\n+after\n+extra\n' })
  assert.match(JSON.stringify(tree), /@@ -8,2 \+10,3 @@/, 'unequal offsets remain explicit instead of inventing unchanged lines')
  const lines = nodes(tree).filter(node => node.props.className === 'nodo-panel-diff-line' && node.props['data-kind'] !== 'meta')
  assert.deepEqual(lines.map(node => node.children[0].children), [[10], [9], [11], [12]], 'context and additions use new numbers; deletions use old numbers')
  assert.equal(lines[2].props['data-kind'], 'added')
  assert.match(JSON.stringify(render({ patch: replacementEdit('x.ts', 'old', 'new').diffText })), /行号相对片段/)
  const fallback = render({ patch: '@@ incomplete patch' })
  assert.match(JSON.stringify(find(fallback, 'nodo-note')), /无法解析差异，以下为原始内容/)
  const raw = nodes(fallback).find(node => node.type === 'CodeBlock')
  assert.equal(raw.type, 'CodeBlock')
  assert.equal(raw.props.wrap, true)
  assert.equal(raw.props.lineNumbers, true)
  assert.equal(raw.props.showHeader, false)
  assert.equal(raw.props.code, '@@ incomplete patch')
})

test('medium panel edits retain a diff when the local calculation exhausts its budget', async () => {
  for (const expired of [false, true]) {
    let now = 0
    const { CodeDiff } = await loadClient('code-diff.tsx', {
      globals: expired ? { Date: { now: () => now += 100 } } : {},
      primitives: { diffTotals: () => ({ added: 500, removed: 500 }) },
    })
    const before = Array.from({ length: 2000 }, (_, index) => `original ${index}\n`)
    const after = before.map((line, index) => index >= 750 && index < 1250 ? `replacement ${index}\n` : line)
    const diff = { path: 'large.ts', oldText: before.join(''), newText: after.join('') }
    const panel = CodeDiff({ filename: diff.path, diff, panel: true })
    const tree = panel.type(panel.props)
    assert.ok(nodes(tree).filter(node => node.type === 'CodeBlock').every(node => node.props.className === 'nodo-panel-diff-code'), 'code blocks only color numbered diff rows; the comparison never silently becomes plain source')
    const native = nodes(tree).find(node => node.type === 'DiffBlock')
    assert.ok(native || nodes(tree).some(node => node.props['data-kind'] === 'added'))
    if (expired) assert.equal(native.props.diffs[0], diff, 'the host receives both complete images after timeout')
  }
})

test('panel replacements without final newlines keep word emphasis and metadata', async () => {
  const { CodeDiff } = await loadClient('code-diff.tsx')
  const panel = CodeDiff({ filename: 'x.ts', panel: true, patch: replacementEdit('x.ts', 'const before = 1', 'const after = 2').diffText })
  const tree = panel.type(panel.props)
  for (const kind of ['removed', 'added']) {
    const row = nodes(tree).find(node => node.props['data-kind'] === kind)
    assert.ok(nodes(row).some(node => node.type === 'mark'))
  }
  assert.equal(nodes(tree).filter(node => node.props['data-kind'] === 'meta').length, 2)
})

test('turn-only multi-file panel patches separate filenames and do not fold across files', async () => {
  const { CodeDiff } = await loadClient('code-diff.tsx')
  const patch = '--- a/first.ts\n+++ b/first.ts\n@@ -1 +1 @@\n-old\n+new\n--- a/second.ts\n+++ b/second.ts\n@@ -80 +80 @@\n-before\n+after\n'
  const panel = CodeDiff({ filename: '轮次差异', patch, panel: true })
  const tree = panel.type(panel.props)
  assert.deepEqual(nodes(tree).filter(node => node.props.className === 'nodo-panel-diff-filename').map(node => node.children[0]), ['first.ts', 'second.ts'])
  assert.ok(!find(tree, 'nodo-panel-diff-gap'))
  assert.deepEqual(nodes(tree).filter(node => node.props.className === 'nodo-panel-diff-number').map(node => node.children[0]), [1, 1, 80, 80])
  assert.ok(nodes(tree).filter(node => node.type === 'CodeBlock').every(node => node.props.lang === 'ts'), 'each file supplies its own syntax language even when the heading is a turn summary')
})

test('panel replacement rows follow the reference single-gutter numbering sequence', async () => {
  const { CodeDiff } = await loadClient('code-diff.tsx')
  const panel = CodeDiff({ filename: 'components/card.tsx', panel: true,
    patch: '@@ -12,4 +12,8 @@\n const shouldReduceMotion = useReducedMotion();\n \n-transition={{ ease: "easeInOut", duration: 0.6 }}\n+transition={\n+  shouldReduceMotion\n+    ? { duration: 0 }\n+    : { type: "spring", duration: 0.25, bounce: 0.1 }\n+}\n \n' })
  const rows = nodes(panel.type(panel.props)).filter(node => node.props.className === 'nodo-panel-diff-line')
  assert.deepEqual(rows.map(row => find(row, 'nodo-panel-diff-number').children[0]), [12, 13, 14, 14, 15, 16, 17, 18, 19])
  assert.ok(rows.every(row => nodes(row).filter(node => node.props.className === 'nodo-panel-diff-number').length === 1))
  assert.deepEqual(rows.map(row => row.props['data-kind']), ['context', 'context', 'removed', 'added', 'added', 'added', 'added', 'added', 'context'])
  assert.ok(rows.every(row => !find(row, 'nodo-panel-diff-sign')), 'the marker lives on the gutter without consuming a separate text column')
})

test('numbered syntax-colored rows preserve nested indentation, tabs, blank lines and continuation text', async () => {
  const { CodeDiff } = await loadClient('code-diff.tsx')
  const text = '              const value = "long payload";  '
  const panel = CodeDiff({ filename: 'nested.tsx', panel: true, patch: `@@ -1,3 +1,3 @@\n ${text}\n-\t  before();\n+\t  after();\n \n` })
  const rows = nodes(panel.type(panel.props)).filter(node => node.props.className === 'nodo-panel-diff-line')
  const colored = rows.map(row => nodes(row).find(node => node.type === 'CodeBlock'))
  assert.deepEqual(colored.map(node => node.props.code), [text, '\t  before();', '\t  after();', ''])
  assert.ok(colored.every(node => node.props.lang === 'tsx' && node.props.wrap && node.props.showHeader === false))
})
