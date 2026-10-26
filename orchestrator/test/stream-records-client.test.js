import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const sample = () => ({ version: 1, kind: 'tool', mode: 'snapshot', runId: 'run', entityId: 'call', revision: 1,
  title: 'Fixture', status: 'error', body: { command: 'echo fixture', outputText: 'partial' }, capture: 'complete', truncated: true,
  details: { state: 'stored', ref: 'fixed-ref' } })
const harness = async call => {
  const { StreamRecordCard, FileChangesSummary, ChangedFile, ResourceList, ResourceItem, CodeDiff, host } = await loadClient(['stream-records.js', 'code-diff.tsx', 'file-changes-summary.tsx'], {
    stubs: { 'feed.js': { TranscriptImage: 'TranscriptImage', ProcessRow: 'ProcessRow' } },
    primitives: {
      DisclosureRow: 'DisclosureRow', IconCodeOutlineRegular: 'Icon', TerminalBlock: 'TerminalBlock',
      DiffBlock: 'DiffBlock', CodeBlock: 'CodeBlock', Button: 'Button',
    },
    call,
  })
  return { context: { ChangedFile, ResourceList, ResourceItem, CodeDiff, FileChangesSummary }, state: host.cells, render: props => { host.reset(); return StreamRecordCard(props) },
    renderChanges: props => { host.reset(); return FileChangesSummary(props) }, renderFile: props => { host.reset(); return ChangedFile(props) }, effects: host.effects }
}
const descendants = node => {
  if (!node || typeof node !== 'object') return []
  return [node, ...[...(node.children ?? []), node.props?.children].flat(Infinity).flatMap(descendants)]
}

test('structured view exposes external error state and fetches saved details without changing ownership', async () => {
  const record = sample(), requests = []
  const h = await harness(async (endpoint, payload) => { requests.push({ endpoint, payload }); return { ...record, body: { outputText: 'retained full output' } } })
  const props = { record, request: { profile: 'p', session: 's' } }
  let tree = h.render(props)
  h.effects[0]()
  assert.equal(tree.props['data-record-status'], 'error')
  const terminal = descendants(tree).find(node => node.type === 'TerminalBlock')
  assert.equal(terminal.props.runStateDot, false)
  await descendants(tree).find(node => node.type === 'Button').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  tree = h.render(props)
  assert.equal(requests[0].endpoint, 'stream-detail')
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].payload)), { profile: 'p', session: 's', ref: 'fixed-ref' })
  assert.match(JSON.stringify(tree), /retained full output/)
})

test('detail errors are visible and stale requests cannot populate a remounted record', async () => {
  const props = { record: sample(), request: { target: 'old-session' } }
  const h = await harness(async () => { throw new Error('详情不可用') })
  let tree = h.render(props)
  h.effects[0]()
  descendants(tree).find(node => node.type === 'Button').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(descendants(h.render(props)).find(node => node.props.role === 'alert').children[0], '详情不可用')
  let resolve
  const pending = await harness(() => new Promise(yes => { resolve = yes }))
  tree = pending.render(props)
  const unmount = pending.effects[0]()
  descendants(tree).find(node => node.type === 'Button').props.onClick()
  unmount()
  resolve({ ...props.record, body: { outputText: 'stale secret fixture' } })
  await new Promise(yes => setImmediate(yes))
  assert.equal(pending.state[1], null)
})

test('file summary distinguishes ten source files, three preview entries and seven expandable entries', async () => {
  const files = Array.from({ length: 10 }, (_, i) => ({ path: `file-${i}`, edits: [] }))
  const record = { ...sample(), kind: 'changes', status: 'done', body: { scope: 'edit-tools', coverage: 'partial', fileCount: 10, files: files.slice(0, 3) } }
  const view = await harness()
  const summary = view.render({ record, request: { target: 'native' } })
  assert.equal(summary.type, view.context.FileChangesSummary)
  assert.equal(summary.props.record.body.fileCount, 10)
  let loaded = false
  const props = { record, value: record, full: null, available: true, busy: false, load: async () => { loaded = true; return { body: { files } } }, renderFile: () => null }
  let tree = view.renderChanges(props)
  assert.equal(descendants(tree).filter(node => node.props.className === 'nodo-changes-file').length, 3)
  assert.match(JSON.stringify(tree), /再显示.*7/)
  descendants(tree).find(node => node.props.className === 'nodo-changes-more').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(loaded, true)
  tree = view.renderChanges({ ...props, full: {}, value: { body: { files } } })
  assert.equal(descendants(tree).filter(node => node.props.className === 'nodo-changes-file').length, 10)
  assert.match(JSON.stringify(tree), /仅包含来源确认的编辑记录/)
})

test('unknown before-images render known after text and raw patches without inventing a full-file addition', async () => {
  const view = await harness()
  const file = { path: 'x', edits: [{ operation: 'update', newText: 'known after' }, { operation: 'update', diffText: '@@ original patch' }] }
  const tree = view.context.ChangedFile({ file, loaded: true })
  assert.equal(descendants(tree).filter(node => node.type === 'DiffBlock').length, 0)
  assert.match(JSON.stringify(tree), /来源未提供修改前内容/)
  const diff = descendants(tree).find(node => node.type === view.context.CodeDiff)
  assert.equal(diff.props.patch, '@@ original patch')
  assert.equal(diff.props.diff, undefined)
})

test('workspace snapshots retain their own attribution and explain binary, oversized and coarse differences', async () => {
  const view = await harness()
  const record = { ...sample(), kind: 'changes', body: { scope: 'workspace-snapshot', fileCount: 1, files: [{ path: '/workspace/x', edits: ['binary', 'oversized', 'coarse', 'unavailable'].map(availability => ({ operation: 'unknown', availability })) }] } }
  const summary = view.render({ record, request: {} })
  assert.equal(summary.type, view.context.FileChangesSummary)
  assert.equal(summary.props.value.body.scope, 'workspace-snapshot')
  const content = view.renderChanges({ ...summary.props })
  assert.match(JSON.stringify(content), /可能包含其他会话或进程的修改/)
  const entry = summary.props.renderFile(record.body.files[0])
  assert.equal(entry.props.inline, true)
  assert.deepEqual(entry.props.request, {})
  const file = view.context.ChangedFile(entry.props)
  assert.match(JSON.stringify(file), /二进制文件/)
  assert.match(JSON.stringify(file), /超过来源大小上限/)
  assert.match(JSON.stringify(file), /粗略差异/)
  assert.match(JSON.stringify(file), /来源未能提供此文件的差异/)
  assert.ok(descendants(file).some(node => node.type === 'Button' && node.children.includes('查看当前内容')))
})

test('a running record shows only the progress facts the source supplied, then drops them at the end', async () => {
  const view = await harness()
  const record = { ...sample(), status: 'running', revision: 2, body: { inputText: 'known input', outputText: 'known output',
    progress: { elapsedMs: 1234, stdoutTail: 'stdout tail fixture', stderrTail: 'stderr tail fixture', stdoutBytes: 7 } }, details: { state: 'unavailable' } }
  const tree = view.render({ record, request: {} })
  const text = JSON.stringify(tree)
  assert.match(text, /已用时 1\.2 秒/)
  assert.match(text, /stdout 7 B/)
  assert.match(text, /stdout（尾部）/)
  assert.match(text, /stderr tail fixture/)
  assert.doesNotMatch(text, /百分比/, 'no percentage is invented without a source')
  const finished = { ...record, status: 'done', body: { inputText: 'known input', outputText: 'known output', progress: record.body.progress } }
  assert.doesNotMatch(JSON.stringify(view.render({ record: finished, request: {} })), /已用时/, 'history never shows a stale live progress')
})

test('saved images render through the attachment component while links, audio and files stay references', async () => {
  const view = await harness()
  const resources = [
    { kind: 'image', state: 'stored', ref: { id: '11111111-1111-1111-1111-111111111111', mediaType: 'image/png' }, name: 'shot.png', mimeType: 'image/png', bytes: 68 },
    { kind: 'image', state: 'unavailable', reason: 'image-too-large', mimeType: 'image/png', bytes: 6000000 },
    { kind: 'link', state: 'reference', name: 'notes.txt', uri: 'file:///workspace/notes.txt', mimeType: 'text/plain', bytes: 12 },
    { kind: 'audio', state: 'unsupported', reason: 'unsupported-type', mimeType: 'audio/wav', bytes: 4 },
    { kind: 'text', state: 'reference', uri: 'file:///workspace/inner.txt', mimeType: 'text/plain', bytes: 13 },
    { kind: 'file', state: 'reference', reason: 'no-reader', name: 'x.bin', bytes: 3 },
  ]
  assert.equal(view.context.ResourceList({ resources }).children.length, resources.length)
  const tree = { children: resources.map(resource => view.context.ResourceItem({ resource })) }
  const images = descendants(tree).filter(node => node.type === 'TranscriptImage')
  assert.equal(images.length, 1)
  assert.equal(images[0].props.image.id, '11111111-1111-1111-1111-111111111111')
  const text = JSON.stringify(tree)
  assert.match(text, /图片超过保存上限/)
  assert.match(text, /file:\/\/\/workspace\/notes.txt/)
  assert.match(text, /不支持音频播放/)
  assert.match(text, /宿主未提供读取或预览通道/)
  assert.match(text, /嵌入文本资源/)
  assert.ok(!descendants(tree).some(node => node.type === 'audio' || node.type === 'a' || node.type === 'video'), 'no player or fetchable link is invented')
  assert.doesNotMatch(text, /iVBORw0KGgo/)
})

test('a pending image says it is saved at the end and a record without resources renders unchanged', async () => {
  const view = await harness()
  const pending = view.context.ResourceItem({ resource: { kind: 'image', state: 'pending', mimeType: 'image/png', bytes: 68 } })
  assert.match(JSON.stringify(pending), /工具结束后保存并展示/)
  const refused = view.context.ResourceItem({ resource: { kind: 'image', state: 'unavailable', reason: 'storage-unavailable' } })
  assert.match(JSON.stringify(refused), /图片未能保存/)
  assert.doesNotMatch(JSON.stringify(refused), /工具结束后保存并展示/)
  const noDecoder = view.context.ResourceItem({ resource: { kind: 'image', state: 'unavailable', reason: 'no-reader' } })
  assert.match(JSON.stringify(noDecoder), /当前宿主无法验证图片，未保存/)
  assert.equal(view.context.ResourceList({ resources: [] }), null)
  const record = { ...sample(), status: 'done', body: { outputText: 'no resource fixture' }, details: { state: 'stored', ref: 'fixed-ref' } }
  const tree = view.render({ record, request: { profile: 'p', session: 's' } })
  assert.doesNotMatch(JSON.stringify(tree), /data-nodo-resources/)
  assert.match(JSON.stringify(tree), /no resource fixture/)
})

test('current file content replaces the diff, returns to the original evidence, and retries failed reads', async () => {
  const requests = []
  const view = await harness(async (endpoint, payload) => {
    requests.push({ endpoint, payload })
    if (requests.length === 2) throw new Error('文件不在会话工作区内')
    return { path: '/ws/note.md', text: 'current body', truncated: true }
  })
  const file = { path: '/ws/note.md', edits: [{ operation: 'update', oldText: 'before', newText: 'after' }] }
  const props = { file, inline: true, request: { profile: 'p', session: 's' } }
  let tree = view.renderFile(props)
  assert.equal(descendants(tree).filter(node => node.type === 'Button').length, 1)
  const click = async label => {
    descendants(view.renderFile(props)).find(node => node.type === 'Button' && node.children.includes(label)).props.onClick()
    await new Promise(resolve => setImmediate(resolve))
  }
  const originalDiff = descendants(tree).find(node => node.type === view.context.CodeDiff).props.diff
  await click('查看当前内容')
  assert.equal(requests[0].endpoint, 'workspace-file')
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].payload)), { profile: 'p', session: 's', path: '/ws/note.md' })
  tree = view.renderFile(props)
  assert.equal(descendants(tree).find(node => node.type === 'CodeBlock').props.code, 'current body')
  assert.ok(!descendants(tree).some(node => node.type === view.context.CodeDiff))
  assert.ok(descendants(tree).some(node => node.type === 'Button' && node.children.includes('返回差异')))
  assert.match(JSON.stringify(tree), /仅显示开头部分/)
  const root = descendants(tree).find(node => node.props['data-nodo-tool-file'] === file.path)
  const popup = { scrollTop: 300 }
  root.props.ref.current = { closest: selector => { assert.equal(selector, '.nodo-changes-preview'); return popup } }
  view.effects.at(-1)()
  assert.equal(popup.scrollTop, 0, 'switching views resets only the preview scroll position')
  await click('返回差异')
  tree = view.renderFile(props)
  assert.deepEqual(descendants(tree).find(node => node.type === view.context.CodeDiff).props.diff, originalDiff)
  assert.ok(!descendants(tree).some(node => node.type === 'CodeBlock'))
  assert.equal(requests.length, 1, 'returning to the diff does not read or alter it')
  await click('查看当前内容')
  tree = view.renderFile(props)
  assert.equal(descendants(tree).find(node => node.props.role === 'alert').children[0], '文件不在会话工作区内')
  assert.ok(!descendants(tree).some(node => node.type === 'CodeBlock' || node.type === view.context.CodeDiff))
  await click('重试')
  tree = view.renderFile(props)
  assert.equal(requests.length, 3)
  assert.equal(descendants(tree).find(node => node.type === 'CodeBlock').props.code, 'current body')
  assert.ok(!descendants(tree).some(node => node.props.role === 'alert'))
  assert.equal(descendants(view.renderFile({ file, loaded: true })).filter(node => node.type === 'Button').length, 0)
})

test('returning to the diff during a read never lets its late response reopen the content view', async () => {
  let resolve
  const view = await harness(() => new Promise(done => { resolve = done }))
  const props = { file: { path: '/ws/x', edits: [{ operation: 'update', oldText: 'old', newText: 'new' }] },
    inline: true, request: { profile: 'p', session: 's' } }
  let tree = view.renderFile(props)
  descendants(tree).find(node => node.type === 'Button').props.onClick()
  tree = view.renderFile(props)
  assert.ok(descendants(tree).some(node => node.props.role === 'status' && node.children.includes('读取中…')))
  assert.ok(!descendants(tree).some(node => node.type === view.context.CodeDiff))
  descendants(tree).find(node => node.type === 'Button' && node.children.includes('返回差异')).props.onClick()
  resolve({ text: 'late file contents' })
  await new Promise(done => setImmediate(done))
  tree = view.renderFile(props)
  assert.ok(descendants(tree).some(node => node.type === view.context.CodeDiff))
  assert.ok(!descendants(tree).some(node => node.type === 'CodeBlock'))
})

test('empty, missing and binary current files show explicit results and retain the return action', async () => {
  for (const [result, label] of [[{ text: '' }, '文件为空。'], [{ missing: true }, '文件已不存在或不是普通文件。'],
    [{ binary: true }, '二进制文件，无法作为文本展示。']]) {
    const view = await harness(async () => result)
    const props = { file: { path: '/ws/x', edits: [] }, inline: true, request: { profile: 'p', session: 's' } }
    descendants(view.renderFile(props)).find(node => node.type === 'Button').props.onClick()
    await new Promise(done => setImmediate(done))
    const tree = view.renderFile(props)
    assert.ok(descendants(tree).some(node => node.children.includes(label)))
    assert.ok(descendants(tree).some(node => node.type === 'Button' && node.children.includes('返回差异')))
    assert.ok(!descendants(tree).some(node => node.type === 'CodeBlock'))
  }
})
