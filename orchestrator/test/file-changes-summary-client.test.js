import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const nodes = node => !node || typeof node !== 'object' ? [] : [node,
  ...(node.type?.name === 'FileTree' ? [node.type(node.props)]
    : [...(node.children ?? []), node.props?.children]).flat(Infinity).flatMap(nodes)]
const find = (tree, className) => nodes(tree).find(node => node.props.className?.split(' ').includes(className))
const patch = '@@ -1 +1,2 @@\n-old\n+new\n+extra\n'
const file = path => ({ path, edits: [{ operation: 'update', diffText: patch }] })
const record = files => ({ version: 1, kind: 'changes', mode: 'snapshot', runId: 'r', entityId: 'c', revision: 1,
  status: 'done', capture: 'complete', truncated: false,
  body: { scope: 'edit-tools', coverage: 'partial', cwd: '/ws', fileCount: files.length, files } })

test('turn-only summaries keep their diff heading as text even with a bound project', async () => {
  let opened
  const { FileChangesSummary, ChangesView, CodeDiff, host } = await loadClient(['file-changes-summary.tsx', 'changes-panel.tsx', 'code-diff.tsx'], { uiShared: {
    rightPanelService: { subscribe() {}, getSnapshot: () => ({ target: { workspace: 'project' } }), openChanges: source => { opened = source }, openFile() { assert.fail('a turn heading has no file') } },
  } })
  const source = record([])
  source.body.turnDiff = patch
  const props = { record: source, value: source, full: source, load: async () => source, renderFile() {} }
  let tree = FileChangesSummary(props)
  await find(tree, 'nodo-changes-view').props.onClick()
  host.cells.length = 0
  host.reset(); tree = ChangesView({ source: opened, openFile() { assert.fail('a turn heading has no file') } })
  const diff = nodes(tree).find(node => node.type === CodeDiff)
  assert.equal(diff.props.filename, '轮次差异')
  assert.equal(diff.props.previewable, false)
  assert.equal(diff.props.panel, true)
  host.reset()
  assert.ok(!find(CodeDiff(diff.props), 'nodo-code-diff-filename'), 'the panel does not add a clickable current-file heading for a turn diff')
})

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

test('summary card previews hovered files above the list and still opens all details on request', async () => {
  const { FileChangesSummary, CodeDiff, host } = await loadClient(['file-changes-summary.tsx', 'code-diff.tsx'])
  const source = record(Array.from({ length: 5 }, (_, index) => file(`/ws/src/${index}.ts`)))
  const renderFile = value => ({ type: 'file-detail', props: { path: value.path }, children: [] })
  const props = { record: source, value: source, full: source, load: async () => source, renderFile }
  const render = () => { host.reset(); return FileChangesSummary(props) }
  let tree = render()
  assert.equal(find(tree, 'nodo-changes-title').children[0], '已编辑')
  assert.equal(nodes(tree).filter(node => node.props.className === 'nodo-changes-file').length, 3)
  assert.deepEqual(find(tree, 'nodo-file-tree-name').children, ['src'])
  assert.equal(nodes(tree).filter(node => node.props['data-kind'] === 'folder').length, 1)
  const firstFile = find(tree, 'nodo-changes-file')
  assert.deepEqual(find(firstFile, 'nodo-file-tree-name').children, ['0.ts'])
  assert.equal(find(firstFile, 'nodo-file-tree-name').props.title, '/ws/src/0.ts')
  assert.deepEqual(find(tree, 'nodo-changes-more').children.slice(0, 1), ['再显示 2 个文件'])
  assert.equal(find(tree, 'nodo-changes-view').props['aria-expanded'], false)
  assert.ok(!find(tree, 'nodo-changes-details'))
  await find(tree, 'nodo-changes-more').props.onClick()
  tree = render()
  assert.equal(nodes(tree).filter(node => node.props.className === 'nodo-changes-file').length, 5)
  nodes(tree).filter(node => node.props.className === 'nodo-changes-file')[1].props.onPointerEnter({ pointerType: 'mouse', currentTarget: {} })
  tree = render()
  assert.deepEqual(nodes(tree).filter(node => node.type === 'file-detail').map(node => node.props.path), ['/ws/src/1.ts'])
  const entries = nodes(tree).filter(node => node.props.className === 'nodo-changes-file-entry')
  assert.equal(entries[1].children[0].props.className, 'nodo-changes-file')
  const preview = find(tree, 'nodo-changes-preview')
  assert.equal(preview.props.id, entries[1].children[0].props['aria-controls'])
  assert.equal(nodes(preview).find(node => node.type === 'file-detail').props.path, '/ws/src/1.ts')
  assert.ok(entries.every(entry => !find(entry, 'nodo-changes-details')), 'hovering adds no inline detail or layout shift')
  assert.equal(find(tree, 'nodo-changes-files').props.id, find(tree, 'nodo-changes-view').props['aria-controls'])
  await find(tree, 'nodo-changes-view').props.onClick()
  tree = render()
  assert.equal(nodes(tree).filter(node => node.type === 'file-detail').length, 5)
  assert.ok(nodes(tree).filter(node => node.props.className === 'nodo-changes-file-entry')
    .every(entry => entry.children[1]?.props.className === 'nodo-changes-details'))
  assert.equal(find(tree, 'nodo-changes-view').props['aria-expanded'], true)
  assert.ok(!find(tree, 'nodo-changes-preview'))
  assert.ok(!nodes(tree).some(node => node.type === CodeDiff), 'the caller renders each source edit without a duplicate diff')
  await find(tree, 'nodo-changes-view').props.onClick()
  assert.ok(!find(render(), 'nodo-changes-details'))
})

test('file previews switch on hover, support click, and close when their row is folded away', async () => {
  const { FileChangesSummary, host } = await loadClient('file-changes-summary.tsx')
  const source = record(Array.from({ length: 5 }, (_, index) => file(`/ws/${index}.ts`)))
  const props = { record: source, value: source, full: source, load: async () => source,
    renderFile: value => ({ type: 'file-detail', props: { path: value.path }, children: [] }) }
  const render = () => { host.reset(); return FileChangesSummary(props) }
  const rows = tree => nodes(tree).filter(node => node.props.className === 'nodo-changes-file')
  let tree = render()
  rows(tree)[0].props.onPointerEnter({ pointerType: 'mouse', currentTarget: {} })
  tree = render()
  rows(tree)[2].props.onPointerEnter({ pointerType: 'mouse', currentTarget: {} })
  tree = render()
  assert.deepEqual(nodes(tree).filter(node => node.type === 'file-detail').map(node => node.props.path), ['/ws/2.ts'])
  assert.ok(!find(tree, 'nodo-changes-details'))
  await find(tree, 'nodo-changes-view').props.onClick()
  tree = render()
  assert.equal(rows(tree).length, 5, 'view all reveals every file and puts each diff under its own row')
  rows(tree)[4].props.onClick({ currentTarget: {} })
  tree = render()
  assert.deepEqual(nodes(tree).filter(node => node.type === 'file-detail').map(node => node.props.path), ['/ws/4.ts'])
  await find(tree, 'nodo-changes-more').props.onClick()
  tree = render()
  assert.equal(rows(tree).length, 3)
  assert.ok(!find(tree, 'nodo-changes-preview'))
  await find(tree, 'nodo-changes-more').props.onClick()
  assert.ok(!find(render(), 'nodo-changes-preview'), 'a hidden selection does not reopen on later expansion')
})

test('directory grouping keeps same-named files linked to their own diffs and only folds files beyond the preview', async () => {
  const { FileChangesSummary, host } = await loadClient('file-changes-summary.tsx')
  const source = record(['src/index.ts', 'test/index.ts', 'src/helper.ts', 'test/late.ts', 'README.md'].map(path => file(`/ws/${path}`)))
  const props = { record: source, value: source, full: source, load: async () => source,
    renderFile: value => ({ type: 'file-detail', props: { path: value.path }, children: [] }) }
  const render = () => { host.reset(); return FileChangesSummary(props) }
  const rows = tree => nodes(tree).filter(node => node.props.className === 'nodo-changes-file')
  const paths = tree => rows(tree).map(row => find(row, 'nodo-file-tree-name').props.title)
  let tree = render()
  assert.deepEqual(paths(tree), ['/ws/src/index.ts', '/ws/src/helper.ts', '/ws/test/index.ts'])
  rows(tree)[2].props.onClick({ currentTarget: {} })
  tree = render()
  assert.equal(nodes(find(tree, 'nodo-changes-preview')).find(node => node.type === 'file-detail').props.path, '/ws/test/index.ts')
  await find(tree, 'nodo-changes-more').props.onClick()
  tree = render()
  assert.equal(rows(tree).length, 5)
  await find(tree, 'nodo-changes-more').props.onClick()
  tree = render()
  assert.equal(rows(tree).length, 3)
  assert.ok(find(tree, 'nodo-changes-preview'), 'an original preview file remains selected after regrouping')
  await find(tree, 'nodo-changes-more').props.onClick()
  tree = render()
  rows(tree).find(row => find(row, 'nodo-file-tree-name').props.title === '/ws/test/late.ts').props.onFocus({ currentTarget: {} })
  await find(render(), 'nodo-changes-more').props.onClick()
  assert.ok(!find(render(), 'nodo-changes-preview'), 'a file hidden by folding loses its preview')
})

test('preview placement fits the viewport and leaves a gap from the hovered file', async () => {
  const { diffPreviewPosition } = await loadClient('hover-preview.tsx')
  const row = { left: 200, top: 500, bottom: 540, width: 800 }
  const above = diffPreviewPosition(row, 1200, 900)
  assert.equal(above.bottom, '408px')
  assert.equal(above.top, 'auto')
  assert.equal(above.maxHeight, '360px')
  const below = diffPreviewPosition({ ...row, top: 30, bottom: 70 }, 1200, 900)
  assert.equal(below.top, '78px')
  assert.equal(below.bottom, 'auto')
  const narrow = diffPreviewPosition({ ...row, left: 250 }, 320, 600)
  assert.equal(narrow.left, '12px')
  assert.equal(narrow.width, '296px')
})

test('preview height stays below the conversation header and inside the available feed area', async () => {
  const { diffPreviewPosition } = await loadClient('hover-preview.tsx')
  const bounds = { top: 300, bottom: 800 }
  const row = { left: 200, top: 500, bottom: 540, width: 800 }
  const above = diffPreviewPosition(row, 1200, 900, bounds)
  const previewBottom = 900 - parseFloat(above.bottom)
  assert.equal(previewBottom, row.top - 8)
  assert.equal(previewBottom - parseFloat(above.maxHeight), bounds.top + 8)
  const below = diffPreviewPosition({ ...row, top: 330, bottom: 370 }, 1200, 900, bounds)
  assert.equal(below.top, '378px')
  assert.equal(below.maxHeight, '360px')
  assert.ok(parseFloat(below.top) + parseFloat(below.maxHeight) <= bounds.bottom - 8)
  const short = diffPreviewPosition({ ...row, top: 410, bottom: 450 }, 1200, 900, { top: 300, bottom: 550 })
  assert.equal(short.maxHeight, '94px', 'small conversation areas shrink the fixed preview instead of covering the header')
})

test('crossing into a preview cancels dismissal, and native popovers close on Escape or outside scroll', async () => {
  let dismiss, refIndex = 0, shown = 0, hidden = 0
  const refs = [], listeners = {}
  const events = { addEventListener: (name, listener) => { listeners[name] = listener }, removeEventListener: name => { delete listeners[name] } }
  const document = { ...events, activeElement: null }
  const { FileChangesSummary, host } = await loadClient('file-changes-summary.tsx', {
    react: { useRef: value => refs[refIndex++] ??= { current: value } },
    globals: { document, window: { ...events, innerWidth: 1200, innerHeight: 900 },
      setTimeout: handler => { dismiss = handler; return 1 }, clearTimeout: () => { dismiss = undefined } },
  })
  const source = record([file('/ws/x.ts')])
  const props = { record: source, value: source, full: source, load: async () => source, renderFile: () => 'diff' }
  const render = () => { refIndex = 0; host.reset(); return FileChangesSummary(props) }
  const row = { getBoundingClientRect: () => ({ left: 200, top: 500, bottom: 540, width: 800 }), contains: target => target === row,
    closest: selector => { assert.equal(selector, '.nodo-feed'); return { getBoundingClientRect: () => ({ top: 300, bottom: 800 }) } } }
  let tree = render()
  find(tree, 'nodo-changes-file').props.onFocus({ currentTarget: row })
  tree = render()
  const popup = { style: {}, contains: target => target === popup, matches: () => true,
    showPopover: ({ source }) => { shown++; assert.equal(source, row) }, hidePopover: () => { hidden++ } }
  find(tree, 'nodo-changes-preview').props.ref.current = popup
  const cleanup = host.effects.at(-1)()
  assert.equal(shown, 1)
  assert.equal(popup.popover, 'manual')
  assert.equal(popup.style.bottom, '408px')
  assert.equal(popup.style.maxHeight, '184px')
  find(tree, 'nodo-changes-file').props.onPointerLeave()
  assert.equal(typeof dismiss, 'function')
  find(tree, 'nodo-changes-preview').props.onPointerEnter()
  assert.equal(dismiss, undefined)
  listeners.scroll({ target: popup })
  assert.ok(find(render(), 'nodo-changes-preview'), 'scrolling within the preview leaves it open')
  listeners.keydown({ key: 'Escape' })
  assert.ok(!find(render(), 'nodo-changes-preview'))
  cleanup()
  assert.equal(hidden, 1)
  assert.equal(Object.keys(listeners).length, 0)
  tree = render()
  find(tree, 'nodo-changes-file').props.onPointerEnter({ pointerType: 'mouse', currentTarget: row })
  tree = render()
  find(tree, 'nodo-changes-preview').props.ref.current = popup
  const cleanupScroll = host.effects.at(-1)()
  listeners.scroll({ target: {} })
  assert.ok(!find(render(), 'nodo-changes-preview'), 'scrolling the feed closes its detached preview')
  cleanupScroll()
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

test('bound projects send file-row clicks to the right panel while hover previews and unbound clicks keep their popups', async () => {
  const opened = []
  let dismiss, target = { workspace: 'project' }
  const { FileChangesSummary, host } = await loadClient('file-changes-summary.tsx', {
    uiShared: { rightPanelService: { subscribe() {}, getSnapshot: () => ({ target }), openChanges: (source, path) => opened.push({ source, path }), openFile() { assert.fail('card clicks open changes') } } },
    globals: { setTimeout: handler => { dismiss = handler; return 1 }, clearTimeout: () => { dismiss = undefined } },
  })
  const source = record([file('/ws/x.ts')])
  const props = { record: source, value: source, full: source, load: async () => source,
    renderFile: value => ({ type: 'file-detail', props: { path: value.path }, children: [] }) }
  const render = () => { host.reset(); return FileChangesSummary(props) }
  let tree = render()
  const row = () => find(tree, 'nodo-changes-file')
  row().props.onPointerEnter({ pointerType: 'mouse', currentTarget: {} })
  tree = render()
  assert.ok(find(tree, 'nodo-changes-preview'), 'hovering still previews the diff with a bound project')
  row().props.onFocus({ currentTarget: {} })
  tree = render()
  assert.ok(find(tree, 'nodo-changes-preview'), 'keyboard focus keeps the same diff popup')
  assert.equal(row().props['aria-haspopup'], 'dialog')
  assert.equal(row().props['aria-controls'], undefined)
  assert.equal(find(tree, 'nodo-changes-view').props['aria-controls'], undefined)
  assert.equal(row().props['aria-expanded'], undefined)
  assert.equal(row().props['aria-label'], '查看 x.ts 的变更')
  row().props.onClick({ currentTarget: {} })
  assert.equal(opened[0].path, '/ws/x.ts')
  assert.equal(opened[0].source.body, source.body)
  dismiss()
  tree = render()
  assert.ok(!find(tree, 'nodo-changes-preview'), 'opening the right panel dismisses the hover popup')
  assert.ok(!find(tree, 'nodo-changes-details'))
  await find(tree, 'nodo-changes-view').props.onClick()
  tree = render()
  assert.ok(!find(tree, 'nodo-changes-details'), 'the bound card does not expand inline')
  assert.equal(opened[1].path, undefined, 'view changes opens the list')
  row().props.onClick({ currentTarget: {} })
  assert.equal(opened[2].path, '/ws/x.ts')
  tree = render()
  assert.ok(!find(tree, 'nodo-changes-details'))
  assert.ok(!find(tree, 'nodo-changes-preview'))
  assert.equal(row().props['aria-controls'], undefined)
  target = null
  tree = render()
  row().props.onClick({ currentTarget: {} })
  assert.equal(opened.length, 3, 'without a target the click keeps opening the popup')
  tree = render()
  const preview = find(tree, 'nodo-changes-preview')
  assert.equal(preview.props.id, row().props['aria-controls'])
  assert.equal(row().props['aria-haspopup'], 'dialog')
  assert.equal(nodes(preview).find(node => node.type === 'file-detail').props.path, '/ws/x.ts')
})

test('bound view changes passes a complete snapshot or a loader for missing files even without a truncated flag', async () => {
  const opened = []
  const { FileChangesSummary, host } = await loadClient('file-changes-summary.tsx', { uiShared: {
    rightPanelService: { subscribe() {}, getSnapshot: () => ({ target: { workspace: 'project' } }), openChanges: source => opened.push(source) },
  } })
  const complete = record(Array.from({ length: 5 }, (_, index) => file(`/ws/${index}.ts`)))
  const preview = { ...complete, body: { ...complete.body, files: complete.body.files.slice(0, 3) } }
  let loads = 0
  const props = { record: preview, value: preview, full: null, available: true,
    load: async () => { loads++; return complete }, renderFile: () => null }
  await find(FileChangesSummary(props), 'nodo-changes-view').props.onClick()
  assert.equal(opened.length, 1)
  assert.equal(opened[0].body.files.length, 3)
  const body = await opened[0].load()
  assert.equal(loads, 1)
  assert.equal(body.files.length, 5)
  host.reset()
  await find(FileChangesSummary({ ...props, value: complete, full: complete }), 'nodo-changes-view').props.onClick()
  assert.equal(opened[1].load, undefined)
  assert.equal(opened[1].body, complete.body)
})

test('hover and focus request the shared diff preview layout', async () => {
  const { FileChangesSummary, host } = await loadClient('file-changes-summary.tsx')
  const source = record([file('/ws/x.ts')]), calls = []
  const props = { record: source, value: source, full: source, load: async () => source,
    renderFile: (...args) => { calls.push(args); return 'preview' } }
  let tree = FileChangesSummary(props)
  find(tree, 'nodo-changes-file').props.onFocus({ currentTarget: {} })
  host.reset(); tree = FileChangesSummary(props)
  assert.equal(find(tree, 'nodo-changes-preview').props.role, 'dialog')
  assert.equal(calls.at(-1)[2], false)
  assert.equal(calls.at(-1)[3], true)
})

test('previews center on the conversation column when the feed bounds are known', async () => {
  const { diffPreviewPosition } = await loadClient('hover-preview.tsx')
  const row = { left: 500, top: 400, bottom: 440, width: 748 }
  const centered = diffPreviewPosition(row, 1800, 900, { left: 430, width: 940, top: 0, bottom: 900 })
  assert.equal(centered.width, '748px')
  assert.equal(centered.left, '526px', 'the popup centers on the feed column, not the hovered row')
  const clamped = diffPreviewPosition(row, 800, 900, { left: 430, width: 940, top: 0, bottom: 900 })
  assert.equal(clamped.left, '40px', 'narrow windows keep the popup inside the viewport')
})
