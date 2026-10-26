import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const nodes = node => !node || typeof node !== 'object' ? [] : [node,
  ...[...(node.children ?? []), node.props?.children].flat(Infinity).flatMap(nodes)]
const find = (tree, className) => nodes(tree).find(node => node.props.className === className)
const record = (body, status = 'done') => ({ version: 1, mode: 'snapshot', kind: 'changes',
  runId: 'run', entityId: 'changes', revision: 1, status, body })

test('timeline disclosure exposes an accessible button and preserves independent step identities and details', async () => {
  const { ToolTimeline, host } = await loadClient('tool-timeline.tsx')
  const detail = { type: 'details', props: {}, children: ['original tool result'] }
  const props = { summary: '工具 2', streaming: true, steps: [
    { id: 'a', icon: 'read', content: detail, active: true },
    { id: 'b', icon: 'read', content: 'same target, another call', active: true, depth: 1, callId: 'b', parentCallId: 'a' },
  ] }
  const render = () => { host.reset(); return ToolTimeline(props) }
  let tree = render()
  const button = find(tree, 'nodo-tool-timeline-trigger')
  const panel = find(tree, 'nodo-tool-timeline-panel')
  assert.equal(button.props.type, 'button')
  assert.equal(button.props['aria-expanded'], false)
  assert.equal(button.props['aria-controls'], panel.props.id)
  assert.equal(panel.props.inert, '')
  assert.equal(panel.props['aria-hidden'], true)
  assert.ok(!nodes(tree).includes(detail))
  button.props.onClick()
  tree = render()
  assert.equal(find(tree, 'nodo-tool-timeline-trigger').props['aria-expanded'], true)
  assert.equal(find(tree, 'nodo-tool-timeline-panel').props.inert, undefined)
  assert.equal(find(tree, 'nodo-tool-timeline-label').children[0], '正在处理')
  assert.ok(nodes(tree).includes(detail))
  const steps = nodes(tree).filter(node => node.type === 'li')
  assert.deepEqual(steps.map(step => step.props.key), ['a', 'b'])
  assert.ok(steps.every(step => step.props['data-active'] === true), 'parallel calls both remain active')
  assert.equal(steps[1].props['data-parent-call-id'], 'a')
  assert.equal(steps[1].props['data-nodo-depth'], 1)
  assert.equal(steps[1].props.style.marginLeft, '16px')
  props.streaming = false
  tree = render()
  assert.ok(nodes(tree).filter(node => node.type === 'li').every(step => step.props['data-active'] === false))
  assert.equal(find(tree, 'nodo-tool-timeline-label').children[0], '2 个步骤')
})

test('timeline retains closing content for the transition and disposes it after the delay', async () => {
  const timers = new Map()
  const { ToolTimeline, host } = await loadClient('tool-timeline.tsx', { globals: {
    setTimeout: (callback, ms) => { timers.set(1, { callback, ms }); return 1 },
    clearTimeout: id => timers.delete(id),
  } })
  const props = { summary: '工具 1', steps: [{ id: 'a', icon: 'read', content: 'saved details' }] }
  const render = () => { host.reset(); host.effects.length = 0; return ToolTimeline(props) }
  let tree = render()
  find(tree, 'nodo-tool-timeline-trigger').props.onClick()
  tree = render()
  host.effects[0]()
  find(tree, 'nodo-tool-timeline-trigger').props.onClick()
  tree = render()
  const cleanup = host.effects[0]()
  assert.ok(find(tree, 'nodo-tool-timeline-steps'))
  assert.equal(find(tree, 'nodo-tool-timeline-panel').props.inert, '')
  assert.equal(timers.get(1).ms, 200)
  find(tree, 'nodo-tool-timeline-trigger').props.onClick()
  cleanup()
  tree = render()
  host.effects[0]()
  assert.equal(timers.size, 0)
  find(tree, 'nodo-tool-timeline-trigger').props.onClick()
  render()
  host.effects[0]()
  timers.get(1).callback()
  assert.ok(!find(render(), 'nodo-tool-timeline-steps'))
})

test('feed keeps commentary and results in order and shows file summary cards outside the timeline', async () => {
  const call = (callId, phase) => ({ kind: 'tool', timeline: true, turnId: 't', callId, phase, name: 'Read', input: 'same.ts' })
  const feed = { key: 'p:s', error: '', lines: [
    { who: 'agent', kind: 'thinking', text: 'reason' }, call('a', 'start'), call('b', 'start'),
    { who: 'agent', kind: 'text', text: 'commentary' },
    call('a', 'end'), call('b', 'end'),
    { kind: 'changes', presentation: record({ scope: 'workspace-snapshot', files: [{ path: 'foreign.ts', edits: [] }], fileCount: 1 }) },
    { who: 'agent', kind: 'text', text: 'final' },
  ] }
  const { Feed, ProcessGroup, ToolTimeline, StreamRecordCard } = await loadClient(['feed.js', 'tool-timeline.tsx', 'stream-records.js'], {
    react: { useState: initial => [initial?.lines ? feed : initial, () => {}] },
  })
  const before = JSON.stringify(feed.lines)
  const tree = Feed({ profile: { id: 'p' }, session: { id: 's' }, work: { active: false, timeline: true } })
  const children = find(tree, 'nodo-feed-inner').children.filter(child => child && typeof child === 'object')
  assert.deepEqual(children.map(node => node.type === ProcessGroup ? 'timeline' : node.type === StreamRecordCard ? 'changes' : node.props.className),
    ['timeline', 'nodo-reply', 'timeline', 'nodo-reply', 'changes'])
  const first = ProcessGroup({ ...children[0].props, children: children[0].children })
  const second = ProcessGroup({ ...children[2].props, children: children[2].children })
  assert.equal(first.type, ToolTimeline)
  assert.deepEqual(Array.from(first.props.steps, step => step.content.props.title), ['思考', '调用 · 读取', '调用 · 读取'])
  assert.deepEqual(Array.from(second.props.steps, step => step.content.props.title), ['结果 · 读取', '结果 · 读取'])
  assert.equal(first.props.summary, '思考 1 · 工具 2')
  assert.equal(first.props.stats, undefined)
  assert.equal(second.props.stats, undefined)
  assert.equal(JSON.stringify(feed.lines), before)
})

test('agent file summaries stay separate from the timeline and child calls keep their nesting', async () => {
  const changes = record({ scope: 'edit-tools', fileCount: 1, files: [{ path: 'src/a.ts', edits: [{ operation: 'update' }] }] })
  const feed = { key: 'p:s', error: '', lines: [
    { kind: 'tool', callId: 'parent', phase: 'end', name: 'Task', activity: true },
    { kind: 'tool', callId: 'child', parentCallId: 'parent', phase: 'end', name: 'Edit', input: 'src/a.ts' },
    { kind: 'changes', presentation: changes },
    { who: 'agent', kind: 'text', text: 'done' },
  ] }
  const { Feed, ProcessGroup, StreamRecordCard } = await loadClient(['feed.js', 'stream-records.js'], {
    react: { useState: initial => [initial?.lines ? feed : initial, () => {}] },
  })
  const tree = Feed({ profile: { id: 'p' }, session: { id: 's' }, work: { active: false } })
  const group = nodes(tree).find(node => node.type === ProcessGroup)
  const timeline = ProcessGroup({ ...group.props, children: group.children })
  assert.equal(timeline.props.steps.length, 2)
  assert.equal(timeline.props.steps[1].depth, 1)
  assert.equal(timeline.props.steps[1].parentCallId, 'parent')
  assert.ok(!timeline.props.steps.some(step => step.content.type === StreamRecordCard))
  assert.equal(timeline.props.stats, undefined)
  assert.equal(timeline.props.steps[1].content.props.timeline, true)
  assert.ok(nodes(tree).some(node => node.type === StreamRecordCard && node.props.record === changes))
})

test('all genuinely pending parallel tools stay active even after a newer commentary message', async () => {
  const feed = { key: 'p:s', error: '', lines: [
    { kind: 'tool', callId: 'a', name: 'Read', phase: 'start' },
    { kind: 'tool', callId: 'b', name: 'Read', phase: 'start' },
    { who: 'agent', kind: 'text', text: 'waiting for both calls' },
  ] }
  const { Feed, ProcessGroup } = await loadClient('feed.js', {
    react: { useState: initial => [initial?.lines ? feed : initial, () => {}] },
  })
  const render = active => {
    const tree = Feed({ profile: { id: 'p' }, session: { id: 's' }, work: { active } })
    const group = nodes(tree).find(node => node.type === ProcessGroup)
    return ProcessGroup({ ...group.props, children: group.children })
  }
  const live = render(true)
  assert.equal(live.props.streaming, true)
  assert.ok(live.props.steps.every(step => step.active))
  const stopped = render(false)
  assert.equal(stopped.props.streaming, false)
  assert.ok(stopped.props.steps.every(step => !step.active))
  assert.ok(stopped.props.steps.every(step => step.content.props.status === 'unknown'))
})

test('structured failure states and interleaved result cards retain their original details', async () => {
  const tool = (callId, phase, status) => ({ kind: 'tool', timeline: true, callId, phase, name: 'Bash',
    presentation: { ...record({ command: 'echo fixture', outputText: 'source output' }, status), kind: 'tool', entityId: callId } })
  const feed = { key: 'p:s', error: '', lines: [
    tool('a', 'start', 'running'), tool('b', 'start', 'running'), tool('a', 'end', 'error'),
    tool('c', 'end', 'denied'), tool('d', 'end', 'interrupted'),
  ] }
  const { Feed, ProcessGroup } = await loadClient('feed.js', {
    react: { useState: initial => [initial?.lines ? feed : initial, () => {}] },
  })
  const tree = Feed({ profile: { id: 'p' }, session: { id: 's' }, work: { active: true } })
  const group = nodes(tree).find(node => node.type === ProcessGroup)
  const timeline = ProcessGroup({ ...group.props, children: group.children })
  const steps = Array.from(timeline.props.steps)
  assert.deepEqual(steps.map(step => step.callId), ['a', 'b', 'a', 'c', 'd'])
  assert.deepEqual(steps.map(step => step.active), [false, true, false, false, false])
  assert.deepEqual(steps.map(step => step.content.props.record.status), ['running', 'running', 'error', 'denied', 'interrupted'])
  assert.ok(steps.every(step => step.content.props.timeline === true))
  assert.equal(steps[0].content.props.eventPhase, 'start')
  assert.equal(steps[2].content.props.eventPhase, 'end')
  assert.ok(steps.every(step => step.content.props.record.body.outputText === 'source output'))
})

test('the last plan remains active after preceding start and result events fold into one card', async () => {
  const feed = { key: 'p:s', error: '', lines: [
    { kind: 'tool', callId: 'a', phase: 'start', name: 'Read' },
    { kind: 'tool', callId: 'a', phase: 'end', name: 'Read' },
    { kind: 'plan', steps: [{ text: 'verify', status: 'in_progress' }] },
  ] }
  const { Feed, ProcessGroup } = await loadClient('feed.js', {
    react: { useState: initial => [initial?.lines ? feed : initial, () => {}] },
  })
  const tree = Feed({ profile: { id: 'p' }, session: { id: 's' }, work: { active: true } })
  const group = nodes(tree).find(node => node.type === ProcessGroup)
  const timeline = ProcessGroup({ ...group.props, children: group.children })
  assert.deepEqual(Array.from(timeline.props.steps, step => step.active), [false, true])
})
