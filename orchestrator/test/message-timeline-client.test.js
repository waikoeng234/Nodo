import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const nodes = node => !node || typeof node !== 'object' ? [] : [node,
  ...[...(node.children ?? []), node.props?.children].flat(Infinity).flatMap(nodes)]

test('request history renders confirmed permissions and answer text while legacy and withdrawn closures remain unknown', async () => {
  const { requestReply } = await loadClient('feed.js')
  const row = response => ({ phase: 'end', response })
  for (const [decision, status] of [['allow', '已允许'], ['deny', '已拒绝'], ['answer', '已回答']]) {
    const result = requestReply(row({ decision, value: decision === 'answer' ? '真实答案\n第二行' : undefined }))
    assert.equal(result.status, status)
    assert.equal(result.text, decision === 'answer' ? '真实答案\n第二行' : '')
  }
  assert.equal(requestReply(row(undefined)).status, '已关闭')
  assert.equal(requestReply({ phase: 'end', cancelled: true }).status, '已取消')
  assert.equal(requestReply({ phase: 'start', text: 'original question' }).status, '等待回答')
  const questions = [{ id: 'a', label: '颜色' }, { id: 'b', label: '饮料' }]
  assert.equal(requestReply(row({ decision: 'answer', questions, value: '{"a":"蓝色","b":"茶"}' })).text, '颜色：蓝色\n饮料：茶')
  assert.equal(requestReply(row({ decision: 'answer', questions, value: 'plain custom answer' })).text, 'plain custom answer')
})

test('turn previews prefer the final parent reply and fall back to the last parent text', async () => {
  const feed = { key: 'p:s', lines: [
    { who: 'user', text: 'first task' },
    { who: 'agent', kind: 'text', text: 'commentary' },
    { who: 'agent', kind: 'text', text: 'partial final block', final: 'complete final answer', reply: true },
    { who: 'agent', kind: 'text', text: 'late commentary' },
    { who: 'agent', kind: 'text', text: 'child answer', parentCallId: 'child' },
    { who: 'user', text: 'legacy task' },
    { who: 'agent', kind: 'text', text: 'legacy first' },
    { who: 'agent', kind: 'text', text: 'legacy last' },
  ] }
  const { Feed } = await loadClient('feed.js', { react: { useState: initial => [initial?.lines ? feed : initial, () => {}] } })
  const tree = Feed({ profile: { id: 'p' }, session: { id: 's' }, work: { active: false } })
  const rail = nodes(tree).find(node => node.type?.name === 'TurnRail')
  assert.deepEqual(Array.from(rail.props.turns, turn => turn.response), ['complete final answer', 'legacy last'])
})

test('answered request rows keep the reply visible after restore and render it as plain text', async () => {
  const feed = { key: 'p:s', error: '', lines: JSON.parse(JSON.stringify([
    { who: 'system', kind: 'request', phase: 'start', requestKind: 'question', text: 'Which option?' },
    { who: 'system', kind: 'request', phase: 'end', requestKind: 'question', response: { decision: 'answer', value: '<img src=x>\nChosen option' } },
  ])) }
  const { Feed } = await loadClient('feed.js', { react: { useState: initial => [initial?.lines ? feed : initial, () => {}] } })
  const tree = Feed({ profile: { id: 'p' }, session: { id: 's' }, work: { active: false } })
  const reply = nodes(tree).find(node => node.props.className === 'nodo-request-answer' && node.children.includes(' · <img src=x>\nChosen option'))
  assert.ok(reply)
  assert.ok(nodes(tree).some(node => node.props['data-request-phase'] === 'end' && node.children.includes('提问 · 已回答')))
  assert.ok(!nodes(tree).some(node => node.type === 'img' || node.props.dangerouslySetInnerHTML))
})

test('the feed interleaves local process groups with independent messages and renders a live message only once', async () => {
  const feed = { key: 'p:s', error: '', lines: [
    { who: 'agent', kind: 'text', timeline: true, messageId: 'intro', text: 'first', open: false },
    { who: 'agent', kind: 'thinking', timeline: true, messageId: 'thought', text: 'reason', open: false },
    { who: 'agent', kind: 'tool', timeline: true, callId: 'a', phase: 'start', name: 'Read' },
    { who: 'agent', kind: 'tool', timeline: true, callId: 'a', phase: 'end', name: 'Read', output: 'body' },
    { who: 'agent', kind: 'text', timeline: true, messageId: 'final', channel: 'final_answer', text: 'last', open: true },
  ] }
  const { Feed, ProcessGroup, StreamingText } = await loadClient(['feed.js', 'streaming-text.tsx'], {
    react: { useState: initial => [initial?.lines ? feed : initial, () => {}] },
  })
  const tree = Feed({ profile: { id: 'p' }, session: { id: 's' }, work: { active: true, timeline: true, buffer: 'first\nlast' } })
  const content = nodes(tree).find(node => node.props.className === 'nodo-feed-inner')
  const children = content.children.filter(child => child && typeof child === 'object')
  assert.equal(children.length, 3)
  assert.equal(children[0].props['data-message-id'], 'intro')
  assert.equal(children[1].type, ProcessGroup)
  assert.equal(children[2].props['data-message-id'], 'final')
  assert.equal(children[2].props['data-source-channel'], 'final_answer')
  assert.equal(nodes(tree).filter(node => node.type === StreamingText).length, 2)
  assert.equal(nodes(tree).filter(node => node.type === StreamingText && node.props.streaming).length, 1)
  assert.equal(nodes(tree).find(node => node.type === StreamingText && node.props.streaming).props.text, 'last')
  assert.ok(!JSON.stringify(tree).includes('first\\nlast'), 'the aggregate work buffer is not a second visible reply')
})

test('reply timestamps appear only on each completed turn final, including after history restore', async () => {
  const feed = { key: 'p:s', error: '', lines: [] }
  const { Feed, TurnUsage } = await loadClient('feed.js', {
    react: { useState: initial => [initial?.lines ? feed : initial, () => {}] },
  })
  for (const [active, reply, open, expected] of [
    [true, undefined, false, ['old-final']],
    [true, undefined, true, ['old-final']],
    [true, true, false, ['old-final']],
    [false, true, false, ['old-final', 'final']],
    [false, false, false, ['old-final']],
  ]) {
    feed.lines = JSON.parse(JSON.stringify([
      { who: 'user', text: 'old task', at: 10 },
      { who: 'agent', kind: 'text', timeline: true, messageId: 'old-intro', text: 'checking', at: 20, reply: false },
      { who: 'agent', kind: 'text', timeline: true, messageId: 'old-final', text: 'done', at: 30, reply: true },
      { who: 'user', text: 'new task', at: 40 },
      { who: 'agent', kind: 'text', timeline: true, messageId: 'intro', text: 'checking again', at: 50, open: false },
      { who: 'agent', kind: 'text', timeline: true, messageId: 'final', channel: 'final_answer', text: 'answer', at: 60, open, reply },
      { who: 'system', kind: 'usage', usage: { outputTokens: 100 } },
      { who: 'agent', kind: 'text', timeline: true, messageId: 'child', parentCallId: 'call', text: 'child answer', at: 70, reply: true },
    ]))
    const before = JSON.stringify(feed.lines)
    const tree = Feed({ profile: { id: 'p' }, session: { id: 's' }, work: { active, timeline: true } })
    const replies = nodes(tree).filter(node => node.props.className === 'nodo-reply')
    const stamped = replies.filter(node => nodes(node).some(child => child.type?.name === 'MessageTime'))
    assert.deepEqual(stamped.map(node => node.props['data-message-id']), expected)
    for (const node of stamped) {
      const stamp = nodes(node).find(child => child.type?.name === 'MessageTime')
      assert.equal(stamp.type(stamp.props).props.dateTime, new Date(stamp.props.at).toISOString())
    }
    assert.equal(nodes(tree).filter(node => node.props.className === 'nodo-user')
      .flatMap(nodes).filter(node => node.type?.name === 'MessageTime').length, 2)
    assert.equal(nodes(tree).filter(node => node.type === TurnUsage).length, open ? 0 : 1)
    assert.equal(JSON.stringify(feed.lines), before)
  }
})

test('a turn usage line joins the stamped reply foot however many removed rows sit between', async () => {
  const feed = { key: 'p:s', error: '', lines: [
    { who: 'user', text: 'task', at: 10 },
    { who: 'agent', kind: 'text', timeline: true, messageId: 'final', text: 'done', at: 20, reply: true },
    { who: 'agent', kind: 'plan', removed: true },
    { who: 'system', kind: 'usage', usage: { outputTokens: 100 } },
  ] }
  const { Feed, TurnUsage } = await loadClient('feed.js', {
    react: { useState: initial => [initial?.lines ? feed : initial, () => {}] },
  })
  const tree = Feed({ profile: { id: 'p' }, session: { id: 's' }, work: { active: false } })
  const usages = nodes(tree).filter(node => node.type === TurnUsage)
  assert.equal(usages.length, 1)
  const reply = usages[0] && nodes(tree).find(node => node.props.className === 'nodo-reply'
    && nodes(node).includes(usages[0]) && nodes(node).some(child => child.type?.name === 'MessageTime'))
  assert.ok(reply, 'the usage caption shares the stamped reply foot with the time')
})

test('a lead conversation hides the usage captions but keeps the reply stamps', async () => {
  const feed = { key: 'p:s', error: '', lines: [
    { who: 'user', text: 'task', at: 10 },
    { who: 'agent', kind: 'text', timeline: true, messageId: 'final', text: 'done', at: 20, reply: true },
    { who: 'agent', kind: 'plan', removed: true },
    { who: 'system', kind: 'usage', usage: { outputTokens: 100 } },
  ] }
  const { Feed, TurnUsage } = await loadClient('feed.js', {
    react: { useState: initial => [initial?.lines ? feed : initial, () => {}] },
  })
  const render = (lead, round) => Feed({ profile: { id: 'p', lead: lead || undefined }, session: { id: 's' }, work: { active: false },
    round: round ? { profiles: [], teams: [], work: {}, onOpen: () => {} } : undefined })
  for (const round of [true, false]) {
    const tree = render(true, round)
    assert.equal(nodes(tree).filter(node => node.type === TurnUsage).length, 0, round ? 'merged view' : 'raw view')
    const reply = nodes(tree).find(node => node.props.className === 'nodo-reply')
    assert.ok(nodes(reply).some(child => child.type?.name === 'MessageTime'), 'the reply foot keeps the time')
  }
  assert.equal(nodes(render(false)).filter(node => node.type === TurnUsage).length, 1, 'a non-lead conversation keeps the caption')
})

test('legacy turns show a timestamp only after their last parent reply and hide it while running', async () => {
  const feed = { key: 'p:s', error: '', lines: [
    { who: 'user', text: 'old task', at: 10 },
    { who: 'agent', kind: 'text', text: 'old progress', at: 20 },
    { who: 'agent', kind: 'text', text: 'old answer', at: 30 },
    { who: 'user', text: 'new task', at: 40 },
    { who: 'agent', kind: 'text', text: 'new progress', at: 50 },
    { who: 'agent', kind: 'text', text: 'new answer', at: 60 },
    { who: 'agent', kind: 'text', text: 'child answer', at: 70, parentCallId: 'call' },
  ] }
  const { Feed } = await loadClient('feed.js', { react: { useState: initial => [initial?.lines ? feed : initial, () => {}] } })
  for (const active of [true, false]) {
    const tree = Feed({ profile: { id: 'p' }, session: { id: 's' }, work: { active } })
    const replies = nodes(tree).filter(node => node.props.className === 'nodo-reply')
    const stamps = replies.flatMap(nodes).filter(node => node.type?.name === 'MessageTime')
    assert.deepEqual(stamps.map(node => node.props.at), active ? [30] : [30, 60])
  }
})

test('interleaved and concurrent tool results stay at their arrival positions, and adjacent pairs remain one card', async () => {
  const { transcriptRows } = await loadClient('feed.js')
  const call = (callId, phase) => ({ who: 'agent', kind: 'tool', timeline: true, turnId: 't', callId, phase, name: 'Read' })
  const rows = transcriptRows([
    call('a', 'start'), call('b', 'start'), call('b', 'end'),
    { who: 'agent', kind: 'text', text: 'between results' }, call('a', 'end'),
  ])
  assert.deepEqual(Array.from(rows, row => [row.item.callId ?? row.item.text, row.item.phase]), [
    ['a', 'start'], ['b', 'start'], ['between results', undefined], ['a', 'end'],
  ])
  assert.equal(rows[0].invocation, true)
  assert.equal(rows.at(-1).result, true)
  assert.equal(rows[1].running, false)
  assert.equal(transcriptRows([call('c', 'start'), call('c', 'end')]).length, 1)
  const foreign = transcriptRows([call('c', 'start'), { ...call('c', 'end'), turnId: 'other' }])
  assert.equal(foreign.length, 2)
  assert.equal(foreign[0].running, true, 'a different turn cannot close this call')
})

test('a run of retry announcements folds into one row that ticks to the newest count and keeps it through the end state', async () => {
  const { transcriptRows, Feed } = await loadClient('feed.js', {
    react: { useState: initial => [initial?.lines ? feed : initial, () => {}] },
  })
  const retry = (phase, extra = {}) => ({ who: 'system', kind: 'lifecycle', event: 'retry', turnId: 't', phase, ...extra })
  const start = (attempt, wait, extra = {}) => retry('start', { text: `第 ${attempt}/10 次，等待 ${wait} 秒`, ...extra })
  // ZCode's engine retries share one identity, so the turn end closes the run once.
  const zcode = transcriptRows([
    start(1, 2), start(2, 3), start(5, 32),
    retry('end', { cancelled: true }),
  ])
  assert.equal(zcode.length, 1)
  assert.equal(zcode[0].item.text, '第 5/10 次，等待 32 秒')
  assert.equal(zcode[0].item.cancelled, true)
  // Claude and Qoder name each attempt, and the turn end closes every one.
  const claude = transcriptRows([
    start(1, 2, { entityId: 'retry-1' }), start(2, 3, { entityId: 'retry-2' }),
    retry('end', { entityId: 'retry-1' }), retry('end', { entityId: 'retry-2' }),
  ])
  assert.equal(claude.length, 1)
  assert.equal(claude[0].item.text, '第 2/10 次，等待 3 秒')
  assert.equal(claude[0].item.phase, 'end')
  assert.equal(transcriptRows([start(1, 2), { ...start(2, 3), turnId: 'u' }]).length, 2,
    'retries of different turns stay their own rows')
  const feed = { key: 'p:s', error: '', lines: JSON.parse(JSON.stringify([
    start(1, 2), start(2, 3),
    retry('end', { entityId: 'retry-1' }), retry('end', { entityId: 'retry-2' }),
  ])) }
  const tree = Feed({ profile: { id: 'p' }, session: { id: 's' }, work: { active: false } })
  const notes = nodes(tree).filter(node => node.props.className === 'nodo-note' && String(node.children[0]).startsWith('重试'))
  assert.equal(notes.length, 1)
  assert.deepEqual(notes[0].children, ['重试 · 已恢复', ' · 第 2/10 次，等待 3 秒'])
})

test('a message completed between polls animates when new, while loaded history stays static', async () => {
  const feed = { key: 'p:s', error: '', lines: [
    { who: 'agent', kind: 'text', timeline: true, at: 100, text: 'history', open: false },
    { who: 'agent', kind: 'text', timeline: true, at: 200, text: 'new completed answer', open: false },
  ] }
  const { Feed, StreamingText } = await loadClient(['feed.js', 'streaming-text.tsx'], {
    globals: { Date: class extends Date { static now() { return 200 } } },
    react: { useState: initial => [initial?.lines ? feed : initial, () => {}] },
  })
  const before = JSON.stringify(feed.lines)
  const tree = Feed({ profile: { id: 'p' }, session: { id: 's' }, work: { active: false, timeline: true } })
  const messages = nodes(tree).filter(node => node.type === StreamingText)
  assert.equal(messages.length, 2)
  assert.equal(messages[0].props.animate, false)
  assert.equal(messages[1].props.animate, true)
  assert.ok(messages.every(node => node.props.streaming === false))
  assert.equal(JSON.stringify(feed.lines), before, 'animation eligibility does not change the stored events')
})

test('nonempty file summaries appear after completion and in history while empty summaries stay hidden', async () => {
  const tool = { version: 1, kind: 'tool', mode: 'snapshot', runId: 'r', entityId: 'edit', revision: 1, status: 'done',
    body: { diffs: [{ path: 'file.ts', oldText: 'before', newText: 'after' }] } }
  const summary = (scope, fileCount) => ({ who: 'agent', kind: 'changes', text: 'summary text must stay hidden',
    presentation: { ...tool, kind: 'changes', body: { scope, fileCount, files: fileCount ? [{ path: 'file.ts', edits: [] }] : [] } } })
  const feed = { key: 'p:s', error: '', lines: [
    { who: 'user', text: 'old task' },
    { who: 'agent', kind: 'text', text: 'old answer' },
    summary('edit-tools', 0),
    { who: 'user', text: 'new task' },
    { who: 'agent', kind: 'tool', name: 'Edit', callId: 'edit', phase: 'end', presentation: tool },
    summary('edit-tools', 1),
    { who: 'agent', kind: 'text', text: 'new answer' },
    summary('workspace-snapshot', 1),
    { who: 'agent', kind: 'changes', text: 'legacy summary must stay hidden' },
  ] }
  const { Feed, ProcessGroup, StreamRecordCard } = await loadClient(['feed.js', 'stream-records.js'], {
    react: { useState: initial => [initial?.lines ? feed : initial, () => {}] },
  })
  const before = JSON.stringify(feed.lines)
  for (const active of [false, true]) {
    const tree = Feed({ profile: { id: 'p' }, session: { id: 's' }, work: { active, timeline: true } })
    const cards = nodes(tree).filter(node => node.type === StreamRecordCard)
    assert.equal(cards.length, active ? 1 : 3)
    const toolCard = cards.find(card => card.props.record.kind === 'tool')
    assert.equal(toolCard.props.record, tool)
    assert.equal(toolCard.props.record.body.diffs[0].newText, 'after')
    assert.ok(!nodes(tree).some(node => node.type === ProcessGroup), 'summary cards do not add empty process groups')
    assert.doesNotMatch(JSON.stringify(tree), /summary.*must stay hidden/)
    assert.equal(nodes(tree).filter(node => node.props.className === 'nodo-reply').length, 2)
    if (!active) {
      const content = nodes(tree).find(node => node.props.className === 'nodo-feed-inner').children.filter(child => child && typeof child === 'object')
      const answer = content.findLastIndex(node => node.props.className === 'nodo-reply')
      assert.ok(content.findIndex(node => node.type === StreamRecordCard && node.props.record.kind === 'changes') > answer,
        'the summary sits after the final answer even when its source event arrived earlier')
    }
  }
  assert.equal(JSON.stringify(feed.lines), before, 'hiding a card does not delete saved events')
})

test('a user message sent with session references shows the referenced replies under it', async () => {
  const feed = { key: 'p:s', error: '', lines: [
    { who: 'user', text: 'use the review', references: [{ id: 'r1', source: { profileName: '大肥鱼', sessionName: '审查' }, messages: [{ text: 'reviewed reply' }] }] },
    { who: 'user', text: 'plain task' },
  ] }
  const { Feed } = await loadClient('feed.js', { react: { useState: initial => [initial?.lines ? feed : initial, () => {}] } })
  const tree = Feed({ profile: { id: 'p' }, session: { id: 's' }, work: { active: false } })
  const history = nodes(tree).filter(node => node.props?.className === 'nodo-reference-history')
  assert.equal(history.length, 1)
  assert.ok(nodes(history[0]).some(node => node.type === 'summary' && node.children.includes('查看本条消息的引用（1）')))
  assert.ok(nodes(history[0]).some(node => node.type === 'strong' && node.children.includes('大肥鱼 · 审查')))
  assert.ok(nodes(history[0]).some(node => node.props?.text === 'reviewed reply'))
})
