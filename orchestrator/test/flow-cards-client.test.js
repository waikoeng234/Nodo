import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : !('type' in node) || !('props' in node) ? []
  : [node, ...Object.values(node.props ?? {}).flatMap(nodes), ...(node.children ?? []).flatMap(nodes)]
const text = node => nodes(node).flatMap(item => item.children ?? []).filter(child => typeof child === 'string').join('|')
const tick = () => new Promise(resolve => setImmediate(resolve))
const by = (tree, predicate) => tree.filter(predicate)
const button = (tree, label) => tree.find(node => node.type === 'Button' && text(node) === label)
const buttons = tree => by(tree, node => node.type === 'Button').map(text)
const fields = tree => by(tree, node => node.type === 'textarea')
const cards = tree => by(tree, node => node.props.className === 'nodo-question-card')
// The head tags carry the state words; the stage rows carry their own flags.
const headTags = tree => by(nodes(tree.find(node => node.props.className === 'nodo-decision-meta')), node => node.props.className === 'nodo-tag').map(text)

const acceptanceCard = (patch = {}) => ({
  id: 'c1', coordinatorSessionId: 'l1', taskId: 't1', kind: 'acceptance', status: 'open', createdAt: 1,
  question: { id: 'acceptance', question: '接受此任务的结果？', whyUser: '请验收任务结果', options: ['accept', 'return'] },
  payload: {
    scope: { quote: '给登录加重试' },
    trigger: { id: 'tr1', summary: '登录失败时自动重试一次，再不行就报错' },
    stages: [
      { executionId: 'x1', stage: 'implement', status: 'done', summary: '加重试逻辑', outcome: 'done', structured: true, questions: [], supplementUnconfirmed: false },
      { executionId: 'x2', stage: 'review', status: 'done', summary: '通过', outcome: 'done', verdict: 'pass', structured: true, questions: [], supplementUnconfirmed: false },
    ],
    evidence: [{ executionId: 'x1', sourceId: 'evidence:x1', evidence: { verification: [{ command: 'npm test', result: 'pass' }, { result: 'not-run' }] } }],
    missedFlags: [], missedFlagsCount: 0, recommendAccept: true,
  },
  ...patch,
})
const stallCard = (patch = {}) => ({
  id: 'c2', coordinatorSessionId: 'l1', taskId: 't1', kind: 'stall', status: 'open', createdAt: 2,
  question: { id: 'stall', question: '任务停滞：execution-failed', whyUser: '请选择下一步', options: ['retry', 'stop'] },
  payload: { stages: [], evidence: [], missedFlags: [], missedFlagsCount: 0, recommendAccept: false, reason: 'execution-failed', retryAction: 'restart-stage', gaps: [] },
  ...patch,
})
const tasks = [{ id: 't1', title: '修复登录' }]

async function setup(answer = async () => ({})) {
  const calls = []
  const loaded = await loadClient('flow-cards.js', {
    call: async (endpoint, payload) => {
      if (endpoint === 'card-answer') { calls.push({ endpoint, payload }); return answer(payload) }
      if (endpoint === 'card-list') return []
      return {}
    },
  })
  const renderCard = (card, extra = {}) => {
    loaded.host.reset()
    return nodes(loaded.FlowCard({ card, task: tasks[0], profileId: 'lead', sessionId: 'l1', readOnly: false,
      onAnswered: async () => { calls.push({ endpoint: 'reloaded' }) }, ...extra }))
  }
  return { loaded, calls, renderCard }
}

test('an acceptance card shows scope, the request, every stage verdict and the evidence handles', async () => {
  const { renderCard, calls } = await setup()
  const tree = renderCard(acceptanceCard())
  assert.equal(text(tree.find(node => node.props.className === 'nodo-decision-status')), '待验收')
  assert.deepEqual(headTags(tree), ['修复登录', '推荐接受'])
  assert.equal(text(tree.find(node => node.props.className === 'nodo-flow-scope')), '给登录加重试')
  assert.equal(text(tree.find(node => node.props.className === 'nodo-flow-trigger')), '登录失败时自动重试一次，再不行就报错')
  const stages = by(tree, node => node.props.className === 'nodo-flow-stage')
  assert.deepEqual(stages.map(node => text(by(nodes(node), item => item.props.className === 'nodo-flow-stage-name'))), ['实现', '审查'])
  assert.deepEqual(stages.map(node => text(by(nodes(node), item => item.props.className === 'nodo-flow-stage-state'))), ['完成', '完成'])
  assert.deepEqual(stages.map(node => by(nodes(node), item => item.props.className === 'nodo-tag').map(text)), [[], ['审查通过']])
  assert.equal(text(tree.find(node => node.props.className === 'nodo-flow-handle')), 'evidence:x1')
  assert.deepEqual(by(tree, node => node.props.className === 'nodo-flow-check').map(text), ['npm test · 通过', '验证 · 未运行'])
  assert.deepEqual(buttons(tree), ['退回', '接受'])
  assert.equal(fields(tree).length, 0, 'the return reason appears only after 退回')
  assert.deepEqual(calls, [])
})

test('the recommendation flips and the warning tags appear exactly when the payload carries them', async () => {
  const { renderCard } = await setup()
  const risky = renderCard(acceptanceCard({ payload: {
    ...acceptanceCard().payload, recommendAccept: false, missedFlagsCount: 2,
    stages: [{ executionId: 'x1', stage: 'implement', status: 'done', summary: '', outcome: 'done', structured: false, questions: [], supplementUnconfirmed: true }],
  } }))
  assert.deepEqual(headTags(risky), ['修复登录', '推荐退回', '漏报风险 2 项'])
  assert.deepEqual(by(risky, node => node.props.className === 'nodo-flow-stage')
    .flatMap(node => by(nodes(node), item => item.props.className === 'nodo-tag').map(text)), ['未结构化', '补充未确认送达'])
})

test('returning demands a reason and sends it verbatim; accepting sends no reason', async () => {
  const { renderCard, calls } = await setup()
  button(renderCard(acceptanceCard()), '退回').props.onClick()
  const tree = renderCard(acceptanceCard())
  assert.deepEqual(buttons(tree), ['取消', '确认退回'], 'the return form swaps the actions')
  assert.equal(fields(tree).length, 1)
  button(tree, '确认退回').props.onClick()
  assert.equal(text(renderCard(acceptanceCard()).find(node => node.props.className === 'nodo-question-feedback')), '请填写退回理由')
  assert.deepEqual(calls, [], 'a blank reason sends nothing')
  fields(renderCard(acceptanceCard()))[0].props.onChange({ target: { value: '第一次返工没改干净' } })
  button(renderCard(acceptanceCard()), '确认退回').props.onClick()
  await tick(); await tick()
  assert.deepEqual(calls, [
    { endpoint: 'card-answer', payload: { profile: 'lead', session: 'l1', cardId: 'c1', action: 'return', reason: '第一次返工没改干净' } },
    { endpoint: 'reloaded' },
  ], 'the reason travels as the rework trigger')
})

test('accepting answers in one click', async () => {
  const { renderCard, calls } = await setup()
  button(renderCard(acceptanceCard()), '接受').props.onClick()
  await tick(); await tick()
  assert.deepEqual(calls, [
    { endpoint: 'card-answer', payload: { profile: 'lead', session: 'l1', cardId: 'c1', action: 'accept' } },
    { endpoint: 'reloaded' },
  ])
})

test('a stalled task names the reason in words and acts only on the listed options', async () => {
  const { renderCard, calls } = await setup()
  const tree = renderCard(stallCard())
  assert.equal(text(tree.find(node => node.props.className === 'nodo-decision-status')), '任务停滞')
  assert.equal(text(tree.find(node => node.props.className === 'nodo-question-title')), '执行失败')
  assert.deepEqual(buttons(tree), ['重试', '终止'], 'no 改变范围 and no extra actions')
  assert.equal(fields(tree).length, 0)
  button(tree, '重试').props.onClick()
  await tick(); await tick()
  assert.deepEqual(calls[0], { endpoint: 'card-answer', payload: { profile: 'lead', session: 'l1', cardId: 'c2', action: 'retry' } })
  assert.deepEqual(calls[1], { endpoint: 'reloaded' }, 'the list re-pulls so a replacement card shows')
})

test('counting stalls offer only 终止 and accept-blocked lists its gaps', async () => {
  const { renderCard, calls } = await setup()
  const blocked = renderCard(stallCard({ payload: { ...stallCard().payload, reason: 'accept-blocked', retryAction: 'check-acceptance', gaps: ['分支未合并', '验证仍有 fail'] } }))
  assert.equal(text(by(blocked, node => node.props.className === 'nodo-flow-gap')[0]), '分支未合并')
  assert.equal(text(by(blocked, node => node.props.className === 'nodo-flow-gap')[1]), '验证仍有 fail')
  assert.deepEqual(buttons(blocked), ['重试', '终止'])

  const counted = renderCard(stallCard({ question: { id: 'stall', question: '任务停滞：rework-limit', whyUser: '请选择下一步', options: ['stop'] },
    payload: { ...stallCard().payload, reason: 'rework-limit', retryAction: null } }))
  assert.deepEqual(buttons(counted), ['终止'], 'a counted stall has no retry')
  assert.equal(text(counted.find(node => node.props.className === 'nodo-question-title')), '返工次数已达上限')
  button(counted, '终止').props.onClick()
  await tick(); await tick()
  assert.deepEqual(calls[0].payload.action, 'stop')
})

test('a failed answer surfaces the host message and releases the buttons', async () => {
  const { renderCard, calls } = await setup(async () => { throw new Error('会话只读，不能作答') })
  const counted = { ...stallCard(), question: { ...stallCard().question, options: ['stop'] } }
  button(renderCard(counted), '终止').props.onClick()
  await tick(); await tick()
  const tree = renderCard(counted)
  assert.equal(text(tree.find(node => node.props.className === 'nodo-question-feedback')), '会话只读，不能作答')
  assert.equal(button(tree, '终止').props.disabled, false, 'a failed answer leaves the card usable')
  assert.deepEqual(calls.map(item => item.payload?.action), ['stop'])
})

test('the list loads for a lead conversation, keeps only open cards and reloads after an answer', async () => {
  const calls = []
  let list = [acceptanceCard(), acceptanceCard({ id: 'c9', status: 'accepted' }), stallCard()]
  const refreshes = []
  const loaded = await loadClient('flow-cards.js', {
    call: async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      if (endpoint === 'card-list') return list
      return {}
    },
  })
  // The fake host leaves nested component elements unexpanded; one level of
  // FlowCard expansion is what the assertions read.
  const render = () => { loaded.host.reset(); return nodes(loaded.FlowCards({ profile: { id: 'lead', lead: true }, session: { id: 'l1' }, struct: 1, readOnly: false, tasks, refresh: async () => refreshes.push(true) }))
    .flatMap(node => typeof node.type === 'function' ? nodes(node.type(node.props)) : [node]) }
  const settle = async () => { for (let round = 0; round < 5; round++) await tick() }
  assert.equal(render().length, 0, 'nothing renders before the first load lands')
  loaded.host.effects.splice(0).forEach(effect => effect())
  await settle()
  assert.deepEqual(calls, [{ endpoint: 'card-list', payload: { profile: 'lead', session: 'l1' } }])
  const tree = render()
  assert.equal(cards(tree).length, 2, 'answered cards leave the action area')
  assert.deepEqual(cards(tree).map(node => node.props['aria-label']), ['任务验收', '任务停滞'])

  button(tree, '重试').props.onClick()
  await settle()
  assert.equal(calls.filter(item => item.endpoint === 'card-list').length, 2, 'an answer re-pulls the list')
  assert.deepEqual(refreshes, [true], 'the view refreshes so task states follow')
  assert.equal(cards(render()).length, 2, 'the stub still lists both open cards')
})

test('a worker conversation never asks for cards', async () => {
  const calls = []
  const loaded = await loadClient('flow-cards.js', { call: async (endpoint, payload) => { calls.push({ endpoint, payload }); return [] } })
  const render = profile => { loaded.host.reset(); return nodes(loaded.FlowCards({ profile, session: { id: 'l1' }, struct: 1, readOnly: false, tasks: [], refresh: async () => {} })) }
  assert.equal(render({ id: 'dev', lead: false }).length, 0)
  loaded.host.effects.splice(0).forEach(effect => effect())
  await tick()
  assert.deepEqual(calls, [], 'only coordinator sessions carry cards')
})

// A stall card puts the title and the gap list straight into the body, so the
// padding rule is what keeps them off the card edge like every other section.
test('the stalled card title and gaps take the horizontal card padding', async () => {
  const { CSS } = await loadClient('styles.js')
  const rule = selector => CSS.split('\n').find(line => line.startsWith(`${selector}{`))?.slice(selector.length + 1, -1) ?? ''
  assert.match(rule('.nodo-flow-body>.nodo-question-title,.nodo-flow-gap'), /padding:0 16px 0 24px/,
    'the stall title and gaps align with the flow sections instead of the card edge')
})
