// The program's acceptance and stall cards for one coordinator session. They
// read like the decision card but answer through card-answer and re-pull the
// list themselves: an accepted card can come back as an accept-blocked stall,
// and answering never starts a lead turn.
import { h, useState, useEffect, call, Button, StateDot, IconChevronDownOutlineRegular } from './ui-shared.js'
import { leadModeOf } from '../../core/shared/lead.js'

// The stall reasons flow.js writes, as the user reads them; the code stays in
// the payload alone.
const STALL_REASONS = {
  'execution-failed': '执行失败',
  'verdict-unreadable': '审查结论无法读取',
  'review-unavailable': '审查类型不可用',
  'delivery-failed': '回报投递失败',
  'lead-error': '主控运行出错',
  'accept-blocked': '验收检查未通过',
  'rework-limit': '返工次数已达上限',
  'hard-cap': '执行数已达上限',
  'stage-rounds': '同一阶段往返已达上限',
}
const STAGES = { implement: '实现', rework: '返工', review: '审查', answer: '补答' }
const OUTCOMES = { done: '完成', blocked: '受阻', failed: '失败' }
const RESULTS = { pass: '通过', fail: '未通过', 'not-run': '未运行' }

const section = (label, ...children) => children.some(child => child ?? false) && h('div', { className: 'nodo-flow-section' },
  h('span', { className: 'nodo-flow-cap' }, label), ...children)

const stageRow = stage => h('div', { key: stage.executionId, className: 'nodo-flow-stage' },
  h('span', { className: 'nodo-flow-stage-name' }, STAGES[stage.stage] ?? stage.stage),
  h('span', { className: 'nodo-flow-stage-state' }, OUTCOMES[stage.outcome] ?? stage.outcome ?? ''),
  stage.verdict && h('span', { className: 'nodo-tag', 'data-tone': stage.verdict === 'pass' ? 'accent' : 'caution' }, `审查${RESULTS[stage.verdict] ?? stage.verdict}`),
  stage.structured === false && h('span', { className: 'nodo-tag', 'data-tone': 'caution' }, '未结构化'),
  stage.supplementUnconfirmed === true && h('span', { className: 'nodo-tag', 'data-tone': 'caution' }, '补充未确认送达'),
  stage.summary && h('span', { className: 'nodo-flow-stage-summary' }, stage.summary))

const evidenceRow = entry => h('div', { key: entry.executionId, className: 'nodo-flow-evidence' },
  h('code', { className: 'nodo-flow-handle' }, entry.sourceId),
  ...(entry.evidence?.verification ?? []).map((item, index) => h('span', { key: index, className: 'nodo-flow-check', 'data-result': item.result },
    `${item.command ?? '验证'} · ${RESULTS[item.result] ?? item.result}`)))

export function FlowCard({ card, task, profileId, sessionId, readOnly, onAnswered }) {
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const [returning, setReturning] = useState(false)
  const [reason, setReason] = useState('')
  const [feedback, setFeedback] = useState('')
  const blocked = busy || readOnly
  const stall = card.kind === 'stall'
  const payload = card.payload
  const answer = async (action, text) => {
    if (blocked) return
    if (action === 'return' && text.trim() === '') return setFeedback('请填写退回理由')
    setBusy(true)
    setFeedback('')
    try {
      await call('card-answer', { profile: profileId, session: sessionId, cardId: card.id, action, ...(action === 'return' ? { reason: text } : {}) })
      await onAnswered()
    } catch (failure) { setFeedback(failure.message); setBusy(false) }
  }
  // A stall card acts on exactly the options the payload lists: the counting
  // stalls only ever offer 终止, the rest add 重试.
  const actions = stall
    ? [...(card.question.options.includes('retry') ? [h(Button, { key: 'retry', variant: 'primary', disabled: blocked, onClick: () => void answer('retry') }, busy ? '提交中…' : '重试')] : []),
      card.question.options.includes('stop') && h(Button, { key: 'stop', variant: 'outline', className: 'nodo-approval-reject', disabled: blocked, onClick: () => void answer('stop') }, '终止')]
    : returning
      ? [h(Button, { key: 'cancel', variant: 'outline', disabled: busy, onClick: () => { setReturning(false); setReason(''); setFeedback('') } }, '取消'),
        h(Button, { key: 'confirm', variant: 'primary', className: 'nodo-approval-reject', disabled: blocked, onClick: () => void answer('return', reason) }, busy ? '提交中…' : '确认退回')]
      : [h(Button, { key: 'return', variant: 'outline', className: 'nodo-approval-reject', disabled: blocked, onClick: () => { setFeedback(''); setReturning(true) } }, '退回'),
        h(Button, { key: 'accept', variant: 'primary', disabled: blocked, onClick: () => void answer('accept') }, busy ? '提交中…' : '接受')]
  return h('div', { className: 'nodo-question-frame' },
    h('section', { className: 'nodo-question-card', 'aria-label': stall ? '任务停滞' : '任务验收', 'aria-busy': busy ? 'true' : undefined },
      h('header', { className: 'nodo-question-head' },
        h('div', { className: 'nodo-decision-heading' },
          h('div', { className: 'nodo-decision-status', role: 'status' },
            h(StateDot, { state: busy ? 'ongoing' : 'warning', size: 7 }), stall ? '任务停滞' : '待验收'),
          h('div', { className: 'nodo-decision-meta' },
            task && h('span', { className: 'nodo-tag', title: task.title }, task.title),
            !stall && h('span', { className: 'nodo-tag', 'data-tone': payload.recommendAccept ? 'accent' : 'caution' },
              payload.recommendAccept ? '推荐接受' : '推荐退回'),
            payload.missedFlagsCount > 0 && h('span', { className: 'nodo-tag', 'data-tone': 'caution' }, `漏报风险 ${payload.missedFlagsCount} 项`))),
        h('button', { type: 'button', className: 'nodo-question-icon nodo-decision-toggle', 'aria-expanded': open,
          'aria-label': open ? '收起' : '展开', onClick: () => setOpen(!open) }, h(IconChevronDownOutlineRegular, { size: 16 }))),
      open && h('div', { className: 'nodo-question-body nodo-flow-body' },
        stall
          ? [h('h2', { className: 'nodo-question-title' }, STALL_REASONS[payload.reason] ?? payload.reason ?? ''),
            ...(payload.gaps ?? []).map((gap, index) => h('p', { key: index, className: 'nodo-flow-gap' }, gap))]
          : [section('范围', payload.scope && h('blockquote', { className: 'nodo-flow-scope' }, payload.scope.quote ?? payload.scope.note ?? '')),
            section('原始请求', payload.trigger?.summary && h('p', { className: 'nodo-flow-trigger' }, payload.trigger.summary)),
            section('阶段', ...payload.stages.map(stageRow)),
            section('证据', ...payload.evidence.map(evidenceRow))],
        !stall && returning && h('textarea', {
          className: 'nodo-question-answer', rows: 2, autoFocus: !readOnly, disabled: blocked, value: reason,
          'aria-label': '退回理由', placeholder: '退回理由将成为返工要求',
          onChange: event => { setFeedback(''); setReason(event.target.value) },
        })),
      h('footer', { className: 'nodo-question-foot' },
        h('p', { className: 'nodo-question-feedback', role: 'alert' }, feedback),
        h('div', { className: 'nodo-question-actions' }, ...actions))))
}

export function FlowCards({ profile, session, struct, readOnly, tasks, refresh }) {
  const [cards, setCards] = useState(null)
  const [failed, setFailed] = useState('')
  const lead = leadModeOf(profile, session) && session != null
  const list = () => call('card-list', { profile: profile.id, session: session.id })
  useEffect(() => {
    if (!lead) { setCards(null); setFailed(''); return }
    let live = true
    list().then(value => { if (live) { setCards(value); setFailed('') } }, failure => { if (live) setFailed(failure.message) })
    return () => { live = false }
  }, [lead, profile?.id, session?.id, struct])
  if (!lead) return null
  // The answered card leaves the action area; an accept the invariants refused
  // has already been swapped for its stall card in the reloaded list.
  const open = (cards ?? []).filter(card => card.status === 'open').sort((a, b) => a.createdAt - b.createdAt)
  if (open.length === 0 && failed === '') return null
  const reload = async () => { setCards(await list()); setFailed(''); await refresh(true) }
  return h('div', { className: 'nodo-flow-cards' },
    open.map(card => h(FlowCard, { key: card.id, card, task: tasks?.find(item => item.id === card.taskId),
      profileId: profile.id, sessionId: session.id, readOnly, onAnswered: reload })),
    open.length === 0 && failed !== '' && h('p', { className: 'nodo-error-line', role: 'alert' }, failed))
}
