import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'

const source = readFileSync(new URL('../src/client/stream-records.js', import.meta.url), 'utf8')
const sample = () => ({ version: 1, kind: 'tool', mode: 'snapshot', runId: 'run', entityId: 'call', revision: 1,
  title: 'Fixture', status: 'error', body: { command: 'echo fixture', outputText: 'partial' }, capture: 'complete', truncated: true,
  details: { state: 'stored', ref: 'fixed-ref' } })
const harness = call => {
  const state = [], effects = []
  let cursor = 0
  const context = createContext({
    h: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState: initial => { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value }] },
    useRef: value => { const i = cursor++; return state[i] ??= { current: value } },
    useEffect: effect => { effects.push(effect) }, call,
    DisclosureRow: 'DisclosureRow', IconCodeOutlineRegular: 'Icon', TerminalBlock: 'TerminalBlock', DiffBlock: 'DiffBlock', CodeBlock: 'CodeBlock', Button: 'Button',
    ProcessRow: 'ProcessRow', TranscriptImage: 'TranscriptImage',
  })
  new Script(source).runInContext(context)
  return { context, state, render: props => { cursor = 0; return context.StreamRecordCard(props) },
    renderChanges: props => { cursor = 0; return context.FileChangesContent(props) }, renderFile: props => { cursor = 0; return context.ChangedFile(props) }, effects }
}
const descendants = node => {
  if (!node || typeof node !== 'object') return []
  return [node, ...[...(node.children ?? []), node.props?.children].flat(Infinity).flatMap(descendants)]
}

test('native tool renderer uses its mounted session, preserves old results and ignores unknown formats', () => {
  const { context } = harness()
  const record = sample()
  const view = context.NativeEngineAction({ phase: 'result', sessionId: 'mounted-session', block: { meta: { nodoRecord: record } } })
  assert.equal(view.props.request.target, 'mounted-session')
  assert.equal(view.props.record, record)
  for (const meta of [{}, { nodoRecord: { ...record, version: 2 } }]) {
    const fallback = context.NativeEngineAction({ phase: 'result', block: { call: { argsRaw: '{"name":"Old tool","input":"old input"}' }, content: [{ type: 'text', text: 'old output' }], meta } })
    assert.equal(fallback.type, 'ProcessRow')
    assert.equal(fallback.props.title, 'Old tool')
    assert.equal(fallback.props.output, 'old output')
  }
})

test('structured view exposes external error state and fetches saved details without changing ownership', async () => {
  const record = sample(), requests = []
  const h = harness(async (endpoint, payload) => { requests.push({ endpoint, payload }); return { ...record, body: { outputText: 'retained full output' } } })
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
  const h = harness(async () => { throw new Error('详情不可用') })
  let tree = h.render(props)
  h.effects[0]()
  descendants(tree).find(node => node.type === 'Button').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(descendants(h.render(props)).find(node => node.props.role === 'alert').children[0], '详情不可用')
  let resolve
  const pending = harness(() => new Promise(yes => { resolve = yes }))
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
  const view = harness()
  assert.match(descendants(view.render({ record, request: { target: 'native' } })).find(node => node.type === 'DisclosureRow').props.title, /10.*部分覆盖/)
  let loaded = false
  const props = { record, value: record, full: null, available: true, busy: false, load: async () => { loaded = true; return { body: { files } } } }
  let tree = view.renderChanges(props)
  assert.equal(descendants(tree).filter(node => node.type === view.context.ChangedFile).length, 3)
  assert.match(JSON.stringify(tree), /展开其余 7 项/)
  descendants(tree).find(node => node.type === 'Button').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(loaded, true)
  tree = view.renderChanges({ ...props, full: {}, value: { body: { files } } })
  assert.equal(descendants(tree).filter(node => node.type === view.context.ChangedFile).length, 10)
  assert.match(JSON.stringify(tree), /不代表本轮净差异/)
})

test('unknown before-images render known after text and raw patches without inventing a full-file addition', () => {
  const view = harness()
  const file = { path: 'x', edits: [{ operation: 'update', newText: 'known after' }, { operation: 'update', diffText: '@@ original patch' }] }
  const tree = view.context.ChangedFile({ file, loaded: true })
  assert.equal(descendants(tree).filter(node => node.type === 'DiffBlock').length, 0)
  assert.match(JSON.stringify(tree), /来源未提供修改前内容/)
  assert.equal(descendants(tree).find(node => node.type === 'CodeBlock' && node.props.lang === 'diff').props.code, '@@ original patch')
})

test('workspace snapshots retain their own attribution and explain binary, oversized and coarse differences', () => {
  const view = harness()
  const record = { ...sample(), kind: 'changes', body: { scope: 'workspace-snapshot', fileCount: 1, files: [{ path: '/workspace/x', edits: [] }] } }
  assert.match(descendants(view.render({ record, request: {} })).find(node => node.type === 'DisclosureRow').props.title, /宿主工作区变更 1/)
  const content = view.renderChanges({ value: record, record })
  assert.match(JSON.stringify(content), /可能包含其他会话或进程的修改/)
  assert.doesNotMatch(JSON.stringify(content), /仅覆盖 Agent 确认完成/)
  const file = view.context.ChangedFile({ file: { path: 'x', edits: ['binary', 'oversized', 'coarse'].map(availability => ({ operation: 'unknown', availability })) }, loaded: true })
  assert.match(JSON.stringify(file), /二进制文件/)
  assert.match(JSON.stringify(file), /超过来源大小上限/)
  assert.match(JSON.stringify(file), /粗略差异/)
})

test('a running record shows only the progress facts the source supplied, then drops them at the end', () => {
  const view = harness()
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

test('saved images render through the attachment component while links, audio and files stay references', () => {
  const view = harness()
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

test('a pending image says it is saved at the end and a record without resources renders unchanged', () => {
  const view = harness()
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

test('changed file rows fetch the current workspace file on demand and only with a session request', async () => {
  const requests = []
  const view = harness(async (endpoint, payload) => {
    requests.push({ endpoint, payload })
    if (requests.length === 2) throw new Error('文件不在会话工作区内')
    return { path: '/ws/note.md', text: 'current body', truncated: true }
  })
  const file = { path: '/ws/note.md', edits: [{ operation: 'update' }] }
  const props = { file, request: { profile: 'p', session: 's' } }
  let tree = view.renderFile(props)
  assert.equal(descendants(tree).filter(node => node.type === 'Button').length, 1)
  const click = async () => { descendants(view.renderFile(props)).find(node => node.type === 'Button').props.onClick(); await new Promise(resolve => setImmediate(resolve)) }
  await click()
  assert.equal(requests[0].endpoint, 'workspace-file')
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].payload)), { profile: 'p', session: 's', path: '/ws/note.md' })
  tree = view.renderFile(props)
  assert.equal(descendants(tree).find(node => node.type === 'CodeBlock').props.code, 'current body')
  assert.match(JSON.stringify(tree), /仅显示开头部分/)
  await click()
  tree = view.renderFile(props)
  assert.equal(descendants(tree).find(node => node.props.role === 'alert').children[0], '文件不在会话工作区内')
  assert.equal(descendants(view.renderFile({ file, loaded: true })).filter(node => node.type === 'Button').length, 0)
})
