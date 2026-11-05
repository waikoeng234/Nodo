import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './helpers/client-module.js'

const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : !('type' in node) || !('props' in node) ? []
  : [node, ...Object.values(node.props ?? {}).flatMap(nodes), ...(node.children ?? []).flatMap(nodes)]
const text = node => nodes(node).flatMap(item => item.children ?? []).filter(child => typeof child === 'string').join('|')
const tick = () => new Promise(resolve => setImmediate(resolve))

const decisionOf = (patch = {}) => ({
  id: 'd1', coordinatorSessionId: 'l1', taskIds: ['t1'], sourceExecutionIds: ['x1'], references: [], stopExecutionIds: ['x2'], status: 'pending', createdAt: 1,
  dispatchBlocked: true,
  questions: [
    { id: 'q1', question: '登录失败时怎么处理？', whyUser: '影响对外行为', recommendation: { optionId: 'retry', reason: '对用户最友好' },
      options: [{ id: 'retry', label: '自动重试', consequence: '多一次请求' }, { id: 'fail', label: '直接报错', consequence: '用户需手动重试' }] },
    { id: 'q2', question: '超时多久？', whyUser: '需要产品取舍' },
  ],
  runningExecutions: [
    { executionId: 'x1', taskId: 't1', sessionId: 'e1', status: 'running', active: true, stopping: false },
    { executionId: 'x2', taskId: 't2', sessionId: 'e2', status: 'running', active: true, stopping: false },
    { executionId: 'x3', taskId: 't3', sessionId: 'e3', status: 'running', active: true, stopping: true },
    { executionId: 'x4', taskId: 't4', sessionId: 'e4', status: 'done', active: false, stopping: false },
  ],
  ...patch,
})
const profiles = [{ id: 'coder', name: 'Coder', sessions: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }, { id: 'e4' }] }]
const tasks = [{ id: 't1', title: 'Fix login' }]

const storageOf = (items = new Map()) => ({ items, getItem: key => items.get(key) ?? null, setItem: (key, value) => { items.set(key, String(value)) } })
async function setup(answer = (endpoint, payload) => ({ status: endpoint === 'decision-answer' ? 'answered' : 'cancelled', message: 'ok' }), localStorage = storageOf()) {
  const calls = [], refreshes = []
  const loaded = await loadClient('run-cards.js', { globals: { localStorage },
    call: async (endpoint, payload) => { calls.push({ endpoint, payload }); return answer(endpoint, payload) } })
  const render = (decision = decisionOf(), extra = {}) => {
    loaded.host.reset()
    return nodes(loaded.DecisionCard({ decision, profileId: 'lead', refresh: async force => { refreshes.push(force) }, profiles, tasks, work: {}, ...extra }))
  }
  const remount = () => { loaded.host.cells.length = 0 }
  return { loaded, calls, refreshes, render, remount, localStorage }
}
const by = (tree, predicate) => tree.filter(predicate)
const options = tree => by(tree, node => node.props.role === 'radio')
const button = (tree, label) => tree.find(node => node.type === 'Button' && text(node) === label)
const fields = tree => by(tree, node => node.type === 'textarea')

const pageNext = tree => tree.find(node => node.props['aria-label'] === '下一题')
const pageBack = tree => tree.find(node => node.props['aria-label'] === '上一题')

test('a pending decision shows one question at a time with consequences and the recommendation, nothing preselected', async () => {
  const { render, calls } = await setup()
  const tree = render()
  assert.equal(text(tree.find(node => node.props.className === 'nodo-decision-status')), '等待用户决定')
  assert.deepEqual(by(tree, node => node.props.className === 'nodo-question-title').map(text), ['登录失败时怎么处理？'])
  assert.deepEqual(by(tree, node => node.props.className === 'nodo-decision-why').map(text), ['影响对外行为'])
  assert.equal(text(tree.find(node => node.props.className === 'nodo-question-progress')), '1 / 2')
  assert.deepEqual(by(tree, node => node.props.className === 'nodo-decision-consequence').map(text), ['多一次请求', '用户需手动重试'])
  const [recommended, other, custom] = options(tree)
  assert.ok(text(recommended).includes('推荐') && text(recommended).includes('对用户最友好'))
  assert.ok(!text(other).includes('推荐'))
  assert.equal(options(tree).length, 3, 'the custom answer is the last option')
  assert.ok(nodes(custom).some(node => node.props.className === 'nodo-question-number' && node.children[0] === 3) && text(custom).includes('自定义回答'))
  assert.ok(options(tree).every(node => node.props['aria-checked'] === false), 'the recommendation is not a selection')
  assert.equal(fields(tree).length, 0, 'no field until the custom option is chosen')
  assert.equal(button(tree, '提交'), undefined, 'only the last question submits')
  assert.ok(button(tree, '下一题'))
  assert.deepEqual(calls, [])
})

test('the custom option opens a text field, excludes the options and counts only with text', async () => {
  const { render } = await setup()
  const single = decisionOf({ questions: [decisionOf().questions[0]] })
  options(render(single))[0].props.onClick()
  options(render(single))[2].props.onClick()
  let tree = render(single)
  assert.deepEqual(options(tree).map(node => node.props['aria-checked']), [false, false, true])
  assert.equal(fields(tree).length, 1)
  assert.equal(button(tree, '提交').props.disabled, true, 'a chosen custom option without text is no answer')
  fields(tree)[0].props.onChange({ target: { value: '   ' } })
  assert.equal(button(render(single), '提交').props.disabled, true)
  fields(render(single))[0].props.onChange({ target: { value: '先问用户' } })
  assert.equal(button(render(single), '提交').props.disabled, false)
  options(render(single))[1].props.onClick()
  tree = render(single)
  assert.deepEqual(options(tree).map(node => node.props['aria-checked']), [false, true, false])
  assert.equal(fields(tree).length, 0)
  assert.equal(button(tree, '提交').props.disabled, false, 'a chosen option needs no text')
})

test('an open question shows only the text field and counts as answered once it has text', async () => {
  const { render, calls } = await setup()
  const open = decisionOf({ questions: [
    { id: 'q1', question: '登录失败时怎么处理？', whyUser: '影响对外行为', options: [] },
    { id: 'q2', question: '超时多久？', whyUser: '需要产品取舍' },
  ] })
  let tree = render(open)
  assert.equal(options(tree).length, 0)
  assert.equal(by(tree, node => node.props.role === 'radiogroup').length, 0)
  assert.equal(fields(tree).length, 1)
  button(tree, '下一题').props.onClick()
  assert.equal(text(render(open).find(node => node.props.className === 'nodo-question-feedback')), '请先完成这道问题。')
  fields(render(open))[0].props.onChange({ target: { value: '自动重试' } })
  button(render(open), '下一题').props.onClick()
  fields(render(open))[0].props.onChange({ target: { value: '   ' } })
  assert.equal(button(render(open), '提交').props.disabled, true, 'blank text is no answer')
  fields(render(open))[0].props.onChange({ target: { value: '30 秒' } })
  tree = render(open)
  assert.equal(button(tree, '提交').props.disabled, false)
  button(tree, '提交').props.onClick()
  await tick(); await tick()
  assert.deepEqual(calls[0].payload.answers, { q1: { text: '自动重试' }, q2: { text: '30 秒' } })
})

test('paging keeps every draft; submitting waits for all questions and sends one answer each', async () => {
  const { render, calls, refreshes } = await setup()
  options(render())[1].props.onClick()
  pageNext(render()).props.onClick()
  let tree = render()
  assert.equal(text(tree.find(node => node.props.className === 'nodo-question-progress')), '2 / 2')
  assert.equal(text(tree.find(node => node.props.className === 'nodo-question-title')), '超时多久？')
  assert.equal(options(tree).length, 0, 'an open question has no option rows')
  assert.equal(button(tree, '提交').props.disabled, true, 'not every question is answered')
  fields(tree)[0].props.onChange({ target: { value: '30 秒' } })
  pageBack(render()).props.onClick()
  assert.equal(options(render())[1].props['aria-checked'], true, 'going back keeps the choice')
  button(render(), '下一题').props.onClick()
  tree = render()
  assert.equal(fields(tree)[0].props.value, '30 秒', 'going forward keeps the text')
  assert.equal(button(tree, '提交').props.disabled, false)
  button(tree, '提交').props.onClick()
  await tick(); await tick()
  assert.deepEqual(calls, [{ endpoint: 'decision-answer', payload: { profile: 'lead', session: 'l1', decisionId: 'd1', answers: { q1: { optionId: 'fail' }, q2: { text: '30 秒' } } } }])
  assert.deepEqual(refreshes, [true])
  assert.equal(text(render().find(node => node.props.className === 'nodo-question-feedback')), '', 'a saved answer needs no message')
})

test('the recommendation reason sits apart from the consequence, only on the recommended option', async () => {
  const { render } = await setup()
  const [recommended, other] = options(render())
  const reason = nodes(recommended).find(node => node.props.className === 'nodo-decision-reason')
  assert.equal(text(reason), '对用户最友好')
  assert.notEqual(reason, nodes(recommended).find(node => node.props.className === 'nodo-decision-consequence'))
  assert.equal(nodes(other).some(node => node.props.className === 'nodo-decision-reason'), false)
})

test('running and unconfirmed stops stay visible next to the linked task', async () => {
  const { render } = await setup()
  const meta = render().find(node => node.props.className === 'nodo-decision-meta')
  assert.deepEqual(nodes(meta).filter(node => node.props.className === 'nodo-tag').map(text),
    ['Fix login', 'Coder · 运行中', 'Coder · 停止未确认', 'Coder · 停止中'], 'a finished execution drops out; none is called stopped')
  const live = render(decisionOf(), { work: { e2: { active: false }, e3: { active: true, stopping: true } } })
  assert.deepEqual(nodes(live.find(node => node.props.className === 'nodo-decision-meta')).filter(node => node.props.className === 'nodo-tag').map(text),
    ['Fix login', 'Coder · 运行中', 'Coder · 停止中'], 'live work overrides the saved execution snapshot')
})

test('a rejected or stale answer shows the host explanation', async () => {
  const { render } = await setup(() => ({ status: 'pending', message: '请完整回答全部问题，不能包含未知问题。' }))
  options(render())[0].props.onClick()
  pageNext(render()).props.onClick()
  fields(render())[0].props.onChange({ target: { value: '10 秒' } })
  button(render(), '提交').props.onClick()
  await tick(); await tick()
  assert.equal(text(render().find(node => node.props.className === 'nodo-question-feedback')), '请完整回答全部问题，不能包含未知问题。')
  const stale = await setup(() => ({ status: 'answered', message: '该决策已回答或已结束，不能撤销；已提交答案保留。' }))
  button(stale.render(), '撤销').props.onClick()
  button(stale.render(), '确认撤销').props.onClick()
  await tick(); await tick()
  assert.equal(text(stale.render().find(node => node.props.className === 'nodo-question-feedback')), '该决策已回答或已结束，不能撤销；已提交答案保留。')
})

test('withdrawing takes a second explicit click; collapsing changes nothing', async () => {
  const { render, calls } = await setup()
  render().find(node => node.props['aria-label'] === '收起').props.onClick()
  const folded = render()
  assert.equal(folded.some(node => node.props.role === 'radio'), false)
  assert.equal(folded.find(node => node.props['aria-label'] === '展开').props['aria-expanded'], false)
  folded.find(node => node.props['aria-label'] === '展开').props.onClick()
  button(render(), '撤销').props.onClick()
  assert.deepEqual(calls, [], 'collapsing and the first withdraw click send nothing')
  button(render(), '确认撤销').props.onClick()
  await tick(); await tick()
  assert.deepEqual(calls, [{ endpoint: 'decision-cancel', payload: { profile: 'lead', session: 'l1', decisionId: 'd1' } }])
})

test('an answered decision shows the submitted answer, locked and waiting for hand-off', async () => {
  const { render } = await setup()
  const answered = decisionOf({ status: 'answered', answer: { values: { q1: { optionId: 'retry' }, q2: { text: '20 秒' } }, userMessageId: 'm', submittedAt: 2 } })
  const tree = render(answered)
  assert.equal(text(tree.find(node => node.props.className === 'nodo-decision-status')), '答案已提交 · 等待交接')
  assert.deepEqual(options(tree).map(node => node.props['aria-checked']), [true, false, false])
  assert.ok(options(tree).every(node => node.props.disabled))
  assert.equal(fields(tree).length, 0)
  pageNext(tree).props.onClick()
  assert.deepEqual(fields(render(answered)).map(node => [node.props.value, node.props.disabled]), [['20 秒', true]], 'the pager still reads every answer')
  assert.equal(button(tree, '提交'), undefined)
  assert.equal(button(tree, '撤销'), undefined)
  assert.equal(text(render({ ...answered, handoffStopped: true }).find(node => node.props.className === 'nodo-decision-status')), '答案已提交 · 主控已停止')
})

test('drafts belong to their decision and survive a remount', async () => {
  const { render, remount } = await setup()
  options(render())[0].props.onClick()
  pageNext(render()).props.onClick()
  fields(render())[0].props.onChange({ target: { value: '5 秒' } })
  remount()
  const other = decisionOf({ id: 'd2', coordinatorSessionId: 'l2' })
  assert.ok(options(render(other)).every(node => node.props['aria-checked'] === false), 'another decision starts clean')
  remount()
  assert.equal(fields(render())[0].props.value, '5 秒', 'switching back restores the draft on the same question')
  pageBack(render()).props.onClick()
  assert.equal(options(render())[0].props['aria-checked'], true)
})

test('a linked task card reads 等待用户 only while its decision is open', async () => {
  const loaded = await loadClient(['run-cards.js', 'round.js'])
  const step = { session: 'e1', profile: 'coder', type: 'feature', taskId: 't1', report: 'Done' }
  const round = { profiles, tasks: [{ id: 't1', title: 'Fix login', status: 'review' }], onOpen() {} }
  const tags = decisions => { loaded.host.reset(); return nodes(loaded.RoundMember({ step, round: { ...round, decisions } })).filter(node => node.props.className === 'nodo-tag').map(text) }
  assert.ok(tags([decisionOf()]).includes('等待用户'))
  assert.ok(!tags([decisionOf({ status: 'delivered' })]).includes('等待用户'))
  assert.ok(tags([decisionOf({ status: 'delivered' })]).includes('待验收'))
})

test('a saved decision answer reads as each question with the chosen answer', async () => {
  const answer = { values: { q1: { optionId: 'fail' }, q2: { text: '30 秒' } }, userMessageId: 'm1', submittedAt: 2 }
  const feed = { lines: [{ id: 'm1', who: 'user', kind: 'text', text: '决策回答：{"q1":{"optionId":"fail"}}', origin: { kind: 'decision-answer', decisionId: 'd1' }, at: 2 }] }
  const { Feed } = await loadClient(['feed.js', 'round.js'], { stubs: { 'live.js': {
    transcriptOf: () => feed.lines, transcriptError: () => '', pullTranscript: async () => {}, watchTranscript: () => () => {}, subscribeStore: () => () => {}, getStoreVersion: () => 0,
  } } })
  const profile = { id: 'lead', name: 'Lead', lead: true }
  const bubble = decisions => nodes(Feed({ profile, session: { id: 'l1' }, work: { active: false }, decisions, round: { profiles: [profile], teams: [], work: {}, onOpen() {} } }))
    .find(node => node.props.className === 'nodo-bubble').children.at(-1)
  assert.equal(bubble([decisionOf({ status: 'delivered', answer })]), '登录失败时怎么处理？\n直接报错\n\n超时多久？\n30 秒')
  assert.equal(bubble([]), feed.lines[0].text, 'without its decision the saved text stays as it is')
})

test('a double click on withdraw does not withdraw; the confirmation can be left and entered again', async () => {
  const { render, calls } = await setup()
  const first = render()
  const actions = tree => by(tree, node => node.type === 'Button').map(text)
  assert.deepEqual(actions(first), ['撤销', '下一题'])
  button(first, '撤销').props.onClick()
  let tree = render()
  assert.deepEqual(actions(tree), ['返回', '确认撤销'], 'the confirm button takes another place than withdraw')
  tree.filter(node => node.type === 'Button')[0].props.onClick()
  assert.deepEqual(calls, [], 'the second click of a double click lands on 返回')
  assert.deepEqual(actions(render()), ['撤销', '下一题'])
  button(render(), '撤销').props.onClick()
  button(render(), '确认撤销').props.onClick()
  await tick(); await tick()
  assert.deepEqual(calls.map(item => item.endpoint), ['decision-cancel'])
})

test('a draft and its question survive a reload and are cleared once submitted or withdrawn', async () => {
  const storage = storageOf()
  const before = await setup(undefined, storage)
  options(before.render())[1].props.onClick()
  pageNext(before.render()).props.onClick()
  fields(before.render())[0].props.onChange({ target: { value: '30 秒' } })
  const after = await setup(undefined, storage)
  let tree = after.render()
  assert.equal(text(tree.find(node => node.props.className === 'nodo-question-progress')), '2 / 2', 'the reload reopens the same question')
  assert.equal(fields(tree)[0].props.value, '30 秒')
  pageBack(after.render()).props.onClick()
  assert.equal(options(after.render())[1].props['aria-checked'], true)
  pageNext(after.render()).props.onClick()
  button(after.render(), '提交').props.onClick()
  await tick(); await tick()
  assert.deepEqual(JSON.parse(storage.items.get('nodo.decisionDrafts')), {}, 'a submitted answer leaves no draft')

  const withdrawn = await setup(undefined, storage)
  options(withdrawn.render())[0].props.onClick()
  assert.ok(JSON.parse(storage.items.get('nodo.decisionDrafts')).d1)
  button(withdrawn.render(), '撤销').props.onClick()
  button(withdrawn.render(), '确认撤销').props.onClick()
  await tick(); await tick()
  assert.deepEqual(JSON.parse(storage.items.get('nodo.decisionDrafts')), {})
})

test('drafts of decisions that are no longer pending are pruned', async () => {
  const { loaded, localStorage } = await setup()
  localStorage.setItem('nodo.decisionDrafts', JSON.stringify({ d1: { answers: {}, open: true, step: 0 }, d2: { answers: {}, open: true, step: 0 }, gone: { answers: {}, open: true, step: 1 } }))
  loaded.pruneDecisionDrafts([decisionOf(), decisionOf({ id: 'd2', status: 'delivered' })])
  assert.deepEqual(Object.keys(JSON.parse(localStorage.getItem('nodo.decisionDrafts'))), ['d1'])
})

test('a pending answer field takes focus, including an open question reached by paging', async () => {
  const { render } = await setup()
  assert.equal(fields(render()).length, 0, 'an option question opens no field by itself')
  options(render())[2].props.onClick()
  assert.equal(fields(render())[0].props.autoFocus, true, 'the custom field focuses as before')
  fields(render())[0].props.onChange({ target: { value: '先问用户' } })
  pageNext(render()).props.onClick()
  const field = fields(render())[0]
  assert.equal(field.props.autoFocus, true)
  assert.equal(field.key ?? field.props.key, 'q2', 'a field per question mounts anew, so paging focuses it')
  const answered = decisionOf({ status: 'answered', answer: { values: { q1: { optionId: 'retry' }, q2: { text: '20 秒' } } } })
  pageNext(render(answered)).props.onClick()
  assert.equal(fields(render(answered))[0].props.autoFocus, false, 'a locked answer takes no focus')
})
