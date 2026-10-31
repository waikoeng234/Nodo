import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const nodes = node => !node || typeof node !== 'object' ? []
  : [node, ...[...(node.children ?? []), node.props?.children].flat(Infinity).flatMap(nodes)]
const find = (tree, className) => nodes(tree).find(node => node.props.className === className)

test('tool calls expose a controlled keyboard button and keep collapsed details inert and unmounted', async () => {
  const { ToolCall, host } = await loadClient('tool-call.tsx')
  const changes = [], content = { type: 'details', props: {}, children: ['请求与结果'] }
  const props = { label: '搜索完成', activeLabel: '正在搜索', query: '文档', status: 'running', open: false,
    onOpenChange: value => changes.push(value), children: content }
  const render = extra => { host.reset(); return ToolCall({ ...props, ...extra }) }
  let tree = render()
  let button = find(tree, 'nodo-tool-call-trigger'), panel = find(tree, 'nodo-tool-call-panel')
  assert.equal(button.type, 'button')
  assert.equal(button.props.type, 'button')
  assert.equal(button.props['aria-expanded'], false)
  assert.equal(button.props['aria-controls'], panel.props.id)
  assert.match(button.props['aria-label'], /正在搜索 文档：运行中/)
  assert.equal(panel.props['aria-hidden'], true)
  assert.equal(panel.props.inert, '')
  assert.ok(!nodes(tree).includes(content))
  button.props.onClick()
  assert.deepEqual(changes, [true])
  assert.equal(find(render(), 'nodo-tool-call-trigger').props['aria-expanded'], false, 'the owner controls expansion')
  tree = render({ open: true })
  button = find(tree, 'nodo-tool-call-trigger'); panel = find(tree, 'nodo-tool-call-panel')
  assert.equal(button.props['aria-expanded'], true)
  assert.equal(panel.props['aria-hidden'], false)
  assert.equal(panel.props.inert, undefined)
  assert.ok(nodes(tree).includes(content))
  button.props.onClick()
  assert.deepEqual(changes, [true, false])
})

test('closing retains details for the transition and reopening cancels their pending removal', async () => {
  const timers = new Map()
  let serial = 0
  const { ToolCall, host } = await loadClient('tool-call.tsx', { globals: {
    setTimeout: (callback, ms) => { timers.set(++serial, { callback, ms }); return serial },
    clearTimeout: id => timers.delete(id),
  } })
  const content = { type: 'details', props: {}, children: ['live output'] }
  const render = open => { host.reset(); return ToolCall({ label: '执行命令', open, onOpenChange() {}, children: content }) }
  render(true)
  host.effects.shift()()
  let tree = render(false)
  const cleanup = host.effects.shift()()
  assert.ok(nodes(tree).includes(content), 'content stays mounted while the panel shrinks')
  assert.equal(find(tree, 'nodo-tool-call-panel').props.inert, '')
  assert.equal([...timers.values()][0].ms, 200)
  tree = render(true)
  cleanup()
  host.effects.shift()()
  assert.equal(timers.size, 0)
  assert.ok(nodes(tree).includes(content))
  render(false)
  host.effects.shift()()
  const pending = [...timers.values()][0]
  pending.callback()
  assert.ok(!nodes(render(false)).includes(content), 'closed details release nested renderers after the transition')
})

test('only a confirmed successful call gets a checkmark and live labels settle without changing arguments', async () => {
  const { ToolCall, host } = await loadClient('tool-call.tsx')
  const expected = { started: '已发起', running: '运行中', done: '已完成', error: '失败', denied: '已拒绝', interrupted: '已停止', unknown: '结果未确认' }
  for (const [status, text] of Object.entries(expected)) {
    host.reset()
    const tree = ToolCall({ label: '已搜索', activeLabel: '正在搜索', query: '<script>fixture</script>', status, open: false, onOpenChange() {} })
    assert.equal(tree.props['data-state'], status)
    assert.equal(find(tree, 'nodo-tool-call-label').children[0], status === 'running' ? '正在搜索' : '已搜索')
    assert.equal(find(tree, 'nodo-tool-call-query').children[0], '<script>fixture</script>')
    assert.equal(find(tree, 'nodo-tool-call-status').props.title, text)
    assert.equal(nodes(tree).filter(node => node.type === 'IconCheckOutlineRegular').length, status === 'done' ? 1 : 0)
    assert.ok(!nodes(tree).some(node => node.props.dangerouslySetInnerHTML || node.type === 'script'))
  }
})

test('primary argument chips support structured and legacy requests, partial JSON and bounded multiline values', async () => {
  const { toolCallQuery } = await loadClient('tool-call.tsx')
  assert.equal(toolCallQuery({ command: 'rg tool-call', description: 'search files' }), 'rg tool-call')
  assert.equal(toolCallQuery('{"file_path":"src/main.ts","content":"full source"}'), 'src/main.ts')
  assert.equal(toolCallQuery({ query: '工具调用' }), '工具调用')
  assert.equal(toolCallQuery({ pattern: '*.tsx' }), '*.tsx')
  assert.equal(toolCallQuery({ path: '', url: 'https://example.com/docs' }), 'https://example.com/docs')
  assert.equal(toolCallQuery('{"query":"partial'), '{"query":"partial')
  assert.equal(toolCallQuery('  echo first\r\necho second'), 'echo first')
  assert.equal(toolCallQuery('x'.repeat(1000)).length, 400)
  assert.equal(toolCallQuery({ content: 'long body' }, 'request summary'), 'request summary')
  assert.equal(toolCallQuery(null), '')
})

test('compact rows keep full arguments and keyboard disclosure while showing exceptional outcomes explicitly', async () => {
  const { ToolCall, host } = await loadClient('tool-call.tsx')
  const query = 'rg '.concat('long/path/'.repeat(25))
  const detail = { type: 'pre', props: {}, children: ['complete output'] }
  for (const status of ['done', 'running', 'started', 'error', 'denied', 'interrupted', 'unknown']) {
    host.reset()
    let opened = false
    const tree = ToolCall({ label: '读取', query, status, compact: true, open: false, onOpenChange: value => { opened = value }, children: detail })
    const button = find(tree, 'nodo-tool-call-trigger')
    assert.equal(find(tree, 'nodo-tool-call-query').props.title, query)
    assert.ok(button.props['aria-label'].includes(query))
    assert.equal(button.children[0].props.className, 'nodo-tool-call-label', 'there is no extra leading disclosure arrow')
    assert.equal(button.children.at(-1).props.className, 'nodo-tool-call-chevron')
    const state = find(tree, 'nodo-tool-call-status')
    if (['done', 'running', 'started'].includes(status)) assert.equal(state, undefined)
    else assert.equal(state.children[0], { error: '失败', denied: '已拒绝', interrupted: '已停止', unknown: '结果未确认' }[status])
    button.props.onClick()
    assert.equal(opened, true)
    assert.ok(!nodes(tree).includes(detail))
    host.reset()
    assert.ok(nodes(ToolCall({ label: '读取', compact: true, open: true, onOpenChange() {}, children: detail })).includes(detail))
  }
})

test('timeline thinking and plans share the compact disclosure and retain complete source bodies', async () => {
  const { ProcessRow, PlanRow, ToolCall, host } = await loadClient(['feed.js', 'tool-call.tsx'])
  const body = 'First paragraph\n\nFull reasoning with original details.'
  const thought = ProcessRow({ kind: 'thinking', title: '思考', summary: 'First paragraph', body, timeline: true })
  assert.equal(thought.type, ToolCall)
  assert.equal(thought.props.kind, 'thinking')
  assert.equal(thought.props.compact, true)
  assert.equal(thought.props.query, 'First paragraph')
  assert.equal(thought.props.children.children[0].props.text, body)
  host.reset()
  const rendered = ToolCall(thought.props)
  assert.equal(find(rendered, 'nodo-tool-call-status'), undefined, 'thinking has no tool completion badge')
  host.reset()
  const plan = PlanRow({ timeline: true, running: true, plan: { steps: [{ text: 'verify', status: 'in_progress' }, { text: 'report', status: 'pending' }] } })
  assert.equal(plan.type, ToolCall)
  assert.equal(plan.props.kind, 'plan')
  assert.equal(plan.props.query, 'verify')
  assert.match(JSON.stringify(plan.props.children), /report/)
  host.reset()
  const row = ProcessRow({ kind: 'tool', title: '读取', input: 'file.ts', timeline: true })
  assert.equal(row.props.compact, true)
})

test('legacy and structured calls share the TSX component and preserve terminal output, saved details and failure states', async () => {
  const { ProcessRow, StreamRecordCard, ToolCall, host } = await loadClient(['feed.js', 'stream-records.js', 'tool-call.tsx'])
  let tree = ProcessRow({ kind: 'tool', title: '读取', input: '{"file_path":"file.ts"}', output: 'body', running: true })
  assert.equal(tree.type, ToolCall)
  assert.equal(tree.props.query, 'file.ts')
  assert.equal(tree.props.status, 'running')
  assert.match(JSON.stringify(tree.props.children), /body/)
  host.reset()
  tree = ProcessRow({ kind: 'tool', title: '读取', status: 'interrupted' })
  assert.equal(tree.props.status, 'interrupted')
  host.reset()
  tree = ProcessRow({ kind: 'tool', title: '读取', error: true })
  assert.equal(tree.props.status, 'error')
  for (const status of ['running', 'done', 'error', 'denied', 'interrupted', 'unknown']) {
    host.reset()
    tree = StreamRecordCard({ timeline: true, record: { kind: 'tool', title: 'Bash', entityId: 'call', status, capture: 'complete',
      body: { command: 'echo fixture', outputText: 'fixture output' }, details: { state: 'stored', ref: 'ref' } }, request: {} })
    const row = nodes(tree).find(node => node.type === ToolCall)
    assert.equal(row.props.compact, true)
    assert.equal(row.props.status, status)
    assert.equal(row.props.query, 'echo fixture')
    assert.equal(nodes(tree).find(node => node.type === 'TerminalBlock').props.output, 'fixture output')
    assert.ok(nodes(tree).some(node => node.type === 'Button' && node.children.includes('查看完整详情')))
    row.props.onOpenChange(true)
    assert.equal(host.cells[0], true)
  }
})

test('the feed never marks a legacy call successful while its completion is missing', async () => {
  const feed = { key: 'profile:session', lines: [{ kind: 'tool', name: 'Read', callId: 'call', phase: 'start', input: 'file.ts' }], error: '' }
  const { Feed, ProcessRow } = await loadClient('feed.js', { react: { useState: initial => [initial?.lines ? feed : initial, () => {}] } })
  const props = { profile: { id: 'profile' }, session: { id: 'session' } }
  const row = nodes(Feed({ ...props, work: { active: false } })).find(node => node.type === ProcessRow)
  assert.equal(row.props.running, false)
  assert.equal(row.props.status, 'unknown')
  assert.equal(nodes(Feed({ ...props, work: { active: true } })).find(node => node.type === ProcessRow).props.running, true)
})

test('edit rows carry the file chip with counts and hover diffs, and the filename opens the right panel', async () => {
  const opened = []
  const { ProcessRow, ToolCall, ToolFileChip, HoverPreview, CodeDiff, host } = await loadClient(
    ['feed.js', 'tool-call.tsx', 'code-diff.tsx', 'hover-preview.tsx'], {
    uiShared: { rightPanelService: { subscribe() {}, getSnapshot: () => ({ target: { workspace: 'w' } }), openFile: path => opened.push(path) } },
  })
  const props = { kind: 'tool', title: '编辑', input: '{"file_path":"/ws/src/a.ts","old_string":"old\\n","new_string":"new\\n"}',
    file: { path: '/ws/src/a.ts', display: 'src/a.ts', name: 'a.ts', directory: 'src/', counts: { added: 1, removed: 1 },
      diffs: [{ path: '/ws/src/a.ts', oldText: 'old\n', newText: 'new\n' }] },
    scope: { profile: 'p', session: 's' }, open: false, onOpenChange() {} }
  let tree = ProcessRow(props)
  assert.equal(tree.type, ToolCall)
  assert.equal(tree.props.query, '/ws/src/a.ts', 'the accessible label keeps the full path')
  assert.equal(tree.props.children, null, 'file rows keep no input/output panel')
  assert.equal(tree.props.expandable, false, 'settled file rows do not expand')
  host.reset()
  const trigger = find(ToolCall(tree.props), 'nodo-tool-call-trigger')
  assert.equal(trigger.props['aria-expanded'], undefined, 'settled chip rows do not advertise expansion')
  assert.equal(trigger.props['aria-controls'], undefined)
  assert.equal(find(ToolCall(tree.props), 'nodo-tool-call-chevron'), undefined, 'settled chip rows hide the disclosure chevron')
  const chipEl = tree.props.queryNode
  assert.equal(chipEl.type, ToolFileChip)
  const chip = ToolFileChip(chipEl.props)
  const icon = nodes(chip).find(node => node.type?.name === 'FileIcon')
  assert.ok(icon, 'the row shows the file type icon')
  assert.equal(icon.type(icon.props).type, 'img')
  assert.equal(find(chip, 'nodo-tool-call-file-name').children[0], 'a.ts')
  assert.equal(find(chip, 'nodo-tool-call-directory').children[0], 'src/')
  assert.equal(find(chip, 'nodo-changes-added').children.join(''), '+1')
  assert.equal(find(chip, 'nodo-changes-removed').children.join(''), '−1')
  assert.equal(find(chip, 'nodo-tool-call-query'), undefined, 'the legacy argument chip is replaced')
  chipEl.props.onShow({})
  host.reset()
  tree = ProcessRow(props)
  assert.equal(tree.props.after.type, HoverPreview)
  const popup = HoverPreview(tree.props.after.props)
  const diff = nodes(popup).find(node => node.type === CodeDiff)
  assert.equal(diff.props.diff.newText, 'new\n')
  assert.equal(diff.props.previewable, false)
  let propagated = false
  find(ToolFileChip(tree.props.queryNode.props), 'nodo-tool-call-file-name')
    .props.onClick({ stopPropagation() { propagated = true } })
  assert.deepEqual(opened, ['/ws/src/a.ts'])
  assert.equal(propagated, true, 'the filename click does not reach the row trigger')
})

test('read rows preview the workspace file on hover, stay closed on failures, and fall back without a right panel', async () => {
  const requests = []
  const { ProcessRow, HoverPreview, HoverFilePreview, ToolFileChip, host } = await loadClient(
    ['feed.js', 'hover-preview.tsx'], {
    uiShared: { rightPanelService: { subscribe() {}, getSnapshot: () => ({ target: null }) },
      call: async (endpoint, payload) => { requests.push([endpoint, payload.path]); return { text: 'file body\n' } } },
  })
  const props = { kind: 'tool', title: '读取', input: '{"file_path":"notes.md"}',
    file: { path: 'notes.md', display: 'notes.md', name: 'notes.md', directory: '', counts: undefined, diffs: [] },
    scope: { profile: 'p', session: 's' }, open: false, onOpenChange() {} }
  let tree = ProcessRow(props)
  assert.equal(find(ToolFileChip(tree.props.queryNode.props), 'nodo-tool-call-file-name').props.role, undefined,
    'without a bound right panel the filename stays plain text')
  tree.props.queryNode.props.onShow({})
  host.reset()
  tree = ProcessRow(props)
  assert.equal(tree.props.after.type, HoverPreview)
  const popup = HoverPreview(tree.props.after.props)
  const reader = nodes(popup).find(node => node.type === HoverFilePreview)
  reader.type(reader.props)
  host.effects.splice(0).forEach(effect => effect())
  await new Promise(resolve => setImmediate(resolve))
  host.reset()
  tree = ProcessRow(props)
  const body = nodes(HoverPreview(tree.props.after.props)).find(node => node.type === HoverFilePreview)
  const code = nodes(body.type(body.props)).find(node => node.type === 'CodeBlock')
  assert.equal(code.props.code, 'file body\n')
  assert.deepEqual(requests, [['workspace-file', 'notes.md']])
})

test('a failing read hides the popup instead of showing it, and toolRow only parses read/write/edit rows', async () => {
  const { toolRow, ProcessRow, HoverPreview, HoverFilePreview, host } = await loadClient(['feed.js', 'hover-preview.tsx'], {
    uiShared: { rightPanelService: { subscribe() {}, getSnapshot: () => ({ target: null }) },
      call: async () => { throw new Error('outside workspace') },
      toolVariant: name => ({ fileChange: 'edit', Bash: 'bash', Grep: 'search', Read: 'read' })[name] ?? 'generic',
      TOOL_VARIANTS: { read: { title: '读取' }, write: { title: '写入' }, edit: { title: '编辑' }, bash: { title: '运行命令' }, search: { title: '搜索' }, generic: { title: '工具调用' } } },
  })
  const session = { id: 's', cwd: '/ws' }
  const row = item => toolRow({ item: { kind: 'tool', name: item.name, callId: 'a', phase: 'end', input: item.input }, index: 0 },
    { profile: { id: 'p' }, session, work: {}, timeline: true })
  const codex = row({ name: 'fileChange', input: '{"changes":[{"path":"a.ts","kind":"modify","diff":"@@ -1 +1 @@\\n-old\\n+new\\n"}]}' })
  assert.equal(codex.props.file.counts.added, 1)
  assert.equal(codex.props.file.display, 'a.ts')
  assert.equal(row({ name: 'Bash', input: 'echo first' }).props.file, null)
  assert.equal(row({ name: 'Grep', input: '{"pattern":"*.ts"}' }).props.file, null)
  assert.equal(row({ name: 'Read', input: 'src/b.ts' }).props.file.name, 'b.ts')
  const props = codex.props
  props.onOpenChange = () => {}
  let tree = ProcessRow({ ...props, scope: { profile: 'p', session: 's' } })
  tree.props.queryNode.props.onShow({})
  host.reset()
  tree = ProcessRow({ ...props, scope: { profile: 'p', session: 's' } })
  const popup = HoverPreview(tree.props.after.props)
  const reader = nodes(popup).find(node => node.type === HoverFilePreview)
  assert.equal(reader, undefined, 'patch rows preview their diff without reading the workspace')
  // 读取行悬停读文件失败时不弹
  const read = ProcessRow({ ...row({ name: 'Read', input: '{"file_path":"x.ts"}' }).props, scope: { profile: 'p', session: 's' } })
  read.props.queryNode.props.onShow({})
  host.reset()
  const readTree = ProcessRow({ ...row({ name: 'Read', input: '{"file_path":"x.ts"}' }).props, scope: { profile: 'p', session: 's' } })
  const readPopup = HoverPreview(readTree.props.after.props)
  nodes(readPopup).find(node => node.type === HoverFilePreview).type(
    nodes(readPopup).find(node => node.type === HoverFilePreview).props)
  host.effects.splice(0).forEach(effect => effect())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.cells[2], null, 'the failed read resets the hover state')
})

test('failed and unconfirmed file rows keep their expansion and error output beside the chip', async () => {
  const { ProcessRow, ToolCall, ToolFileChip, host } = await loadClient(
    ['feed.js', 'tool-call.tsx', 'hover-preview.tsx'], {
    uiShared: { rightPanelService: { subscribe() {}, getSnapshot: () => ({ target: null }) } },
  })
  const file = { path: '/ws/src/a.ts', display: 'src/a.ts', name: 'a.ts', directory: 'src/', counts: undefined,
    diffs: [{ path: '/ws/src/a.ts', oldText: 'old\n', newText: 'new\n' }] }
  const props = { kind: 'tool', title: '编辑', input: '{"file_path":"/ws/src/a.ts"}', file,
    scope: { profile: 'p', session: 's' }, open: false, onOpenChange() {}, error: true, output: 'boom' }
  let tree = ProcessRow(props)
  assert.notEqual(tree.props.children, null, 'a failed edit row keeps its input/output panel')
  assert.match(JSON.stringify(tree.props.children), /boom/)
  assert.match(JSON.stringify(tree.props.children), /data-error/)
  assert.equal(tree.props.expandable, undefined, 'a failed edit row still expands')
  assert.equal(tree.props.queryNode.type, ToolFileChip)
  tree.props.onOpenChange(true)
  assert.equal(host.cells[0], true, 'the failed row toggles open')
  host.reset()
  tree = ProcessRow(props)
  const rendered = ToolCall(tree.props)
  assert.equal(find(rendered, 'nodo-tool-call-trigger').props['aria-expanded'], true)
  assert.ok(find(rendered, 'nodo-tool-call-chevron'))
  for (const status of ['denied', 'interrupted', 'unknown']) {
    host.reset()
    assert.notEqual(ProcessRow({ ...props, error: false, output: '', status }).props.children, null,
      `${status} rows keep their details`)
  }
})

test('stream records keep status and output for failed file rows and stay collapsed when done', async () => {
  const { StreamRecordCard, ToolCall, ToolFileChip, host } = await loadClient(
    ['feed.js', 'stream-records.js', 'tool-call.tsx', 'hover-preview.tsx'], {})
  const record = status => ({ version: 1, kind: 'tool', runId: 'r', entityId: 'e', revision: 1, title: 'Edit', status,
    capture: 'complete', truncated: true, body: { inputText: '{"file_path":"a.ts","old_string":"a\\n","new_string":"b\\n"}', outputText: 'boom' },
    details: { state: 'stored', ref: 'ref' } })
  for (const status of ['error', 'denied', 'interrupted', 'unknown']) {
    host.reset()
    const row = nodes(StreamRecordCard({ record: record(status), request: { profile: 'p', session: 's' } }))
      .find(node => node.type === ToolCall)
    assert.equal(row.props.queryNode.type, ToolFileChip)
    assert.notEqual(row.props.children, null, `${status} records keep their status line and output`)
    assert.match(JSON.stringify(row.props.children), /boom/)
  }
  host.reset()
  const done = nodes(StreamRecordCard({ record: record('done'), request: {} })).find(node => node.type === ToolCall)
  assert.equal(done.props.children, null, 'done records stay collapsed')
  assert.equal(done.props.expandable, false)
  assert.equal(done.props.queryNode.type, ToolFileChip)
})

test('stream record cards hand their request scope and cwd to the resource list', async () => {
  const { StreamRecordCard, ResourceList, host } = await loadClient(
    ['feed.js', 'stream-records.js', 'tool-call.tsx', 'hover-preview.tsx'], {})
  const request = { profile: 'p', session: 's' }
  const resources = [{ kind: 'link', state: 'reference', name: 'a.md', uri: 'a.md' }]
  host.reset()
  const list = nodes(StreamRecordCard({ record: { ...sampleRecord(), body: { outputText: 'fixture', resources } },
    request, cwd: '/ws' })).find(node => node.type === ResourceList)
  assert.deepEqual(JSON.parse(JSON.stringify(list.props)), { resources, scope: request, cwd: '/ws' })
})

const sampleRecord = () => ({ version: 1, kind: 'tool', runId: 'r', entityId: 'e', revision: 1, title: 'Fixture', status: 'done',
  capture: 'complete', body: {}, details: { state: 'unavailable' } })
