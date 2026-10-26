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
