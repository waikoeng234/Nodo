import { h, useState, call, Button, StateDot, IconChevronDownOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular } from './ui-shared.js'
import { RoleAvatar } from './avatar.tsx'
import { engineDisplayName } from './engine-logos.js'

// A pending request takes the host's own composer takeover for the same thing:
// a permission is the host's approval panel (warning strip, headline, reject /
// allow once, Enter and Escape as shortcuts), a question is the host's question
// composer (eyebrow + question, numbered options, custom answer, pager, submit).
const RECOMMENDED_LABEL = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i
// The host marks a recommended option inside the label itself; the badge is
// decoration, and the raw label stays the answer the engine receives.
const optionText = label => RECOMMENDED_LABEL.test(label)
  ? { text: label.replace(RECOMMENDED_LABEL, ''), recommended: true }
  : { text: label, recommended: false }

// Pieces of the question composer shared by engine questions and user decisions.
const questionOption = ({ key, index, selected, disabled, onClick, label, recommended, line }, ...children) => h('button', {
  key, type: 'button', role: 'radio', 'aria-checked': selected,
  className: 'nodo-question-option', 'data-selected': selected ? '' : undefined, disabled, onClick,
},
h('span', { className: 'nodo-question-number', 'aria-hidden': true }, index + 1),
h('span', { className: 'nodo-question-copy' },
  h('span', { className: 'nodo-question-line' },
    h('span', { className: 'nodo-question-label' }, label),
    recommended && h('span', { className: 'nodo-tag', 'data-tone': 'accent' }, '推荐'),
    line),
  ...children))
const questionAnswer = ({ key, value, disabled, label, placeholder, autoFocus, onChange, onEnter }) => h('textarea', {
  key, className: 'nodo-question-answer', rows: 1, disabled, value, 'aria-label': label, placeholder, autoFocus,
  onChange: event => onChange(event.target.value),
  onKeyDown: event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); onEnter() } },
})
const questionPager = ({ step, count, disabled, onBack, onNext }) => count > 1 && h('div', { className: 'nodo-question-pager' },
  h('button', { type: 'button', className: 'nodo-question-icon', 'aria-label': '上一题', disabled: step === 0 || disabled, onClick: onBack },
    h(IconChevronLeftOutlineRegular, { size: 16 })),
  h('span', { className: 'nodo-question-progress' }, `${step + 1} / ${count}`),
  h('button', { type: 'button', className: 'nodo-question-icon', 'aria-label': '下一题', disabled: step === count - 1 || disabled, onClick: onNext },
    h(IconChevronRightOutlineRegular, { size: 16 })))

export function ApprovalCard({ card, refresh, readOnly, from }) {
  const questions = card.detail?.questions?.length
    ? card.detail.questions
    : [{ id: 'answer', question: card.reason, options: (card.detail?.options ?? []).map(label => ({ label })) }]
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const blocked = busy || readOnly
  const question = questions[Math.min(step, questions.length - 1)]
  const draft = answers[question.id] ?? ''
  const last = step === questions.length - 1
  const pick = next => setAnswers(current => ({ ...current, [question.id]: next }))
  const answer = async (decision, value) => {
    if (blocked) return
    setBusy(true)
    setError('')
    try {
      await call('approval-answer', { id: card.id, decision, ...(decision === 'answer' ? { value } : {}) })
      await refresh(true)
    } catch (failure) { setError(failure.message); setBusy(false); await refresh(true) }
  }
  const submit = () => {
    if (questions.some(item => (answers[item.id] ?? '').trim() === '')) return setError('请选择一个选项或填写自定义答案。')
    void answer('answer', questions.length === 1 ? answers[question.id] : JSON.stringify(answers))
  }
  const next = () => {
    if (draft.trim() === '') return setError('请先完成这道问题。')
    setError('')
    if (last) submit()
    else setStep(step + 1)
  }

  if (card.kind === 'permission') {
    // Enter allows and Escape rejects, as in the host's panel — but only while
    // the key comes from the card itself, never from a field or a button.
    const keydown = (event) => {
      if (blocked || event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.key !== 'Enter' && event.key !== 'Escape') return
      if (event.target.closest?.('input, textarea, select, button, a[href], [contenteditable]')) return
      event.preventDefault()
      void answer(event.key === 'Enter' ? 'allow' : 'deny')
    }
    return h('div', { className: 'nodo-approval', onKeyDown: keydown, 'aria-busy': busy ? 'true' : undefined },
      h('section', { className: 'nodo-approval-card' },
        h('div', { className: 'nodo-approval-strip', role: 'alert' },
          h(StateDot, { state: busy ? 'ongoing' : 'warning' }),
          h('span', { className: 'nodo-approval-label' }, from || card.taskTitle ? '等待审批 ·' : '等待审批'),
          card.taskTitle && card.taskTitle !== from?.session.name && h('span', { className: 'nodo-approval-task' }, card.taskTitle),
          from && h('span', { className: 'nodo-approval-from' }, h(RoleAvatar, { profile: from.role, size: 16 }),
            h('span', null, [from.role.name, from.role.engine && engineDisplayName({ id: from.role.engine }), from.session.name].filter(Boolean).join(' · ')))),
        h('div', { className: 'nodo-approval-body', tabIndex: 0, role: 'group', 'aria-label': '审批详情' },
          h('p', { className: 'nodo-approval-headline' }, card.tool ? `工具「${card.tool}」请求执行` : card.reason),
          card.tool && card.reason ? h('p', { className: 'nodo-approval-command' }, card.reason) : null,
          card.tool === 'ExitPlanMode' && typeof (card.detail?.input?.plan ?? card.detail?.toolCall?.rawInput?.plan) === 'string'
            && h('div', { className: 'nodo-approval-plan' }, card.detail?.input?.plan ?? card.detail?.toolCall?.rawInput?.plan)),
        h('div', { className: 'nodo-approval-actions' },
          h(Button, { variant: 'outline', className: 'nodo-approval-reject', disabled: blocked, onClick: () => void answer('deny') }, '拒绝'),
          h(Button, { variant: 'primary', disabled: blocked, onClick: () => void answer('allow') }, '允许一次'))),
      error && h('p', { className: 'nodo-approval-error', role: 'alert' }, error))
  }

  return h('div', { className: 'nodo-question-frame' },
    h('section', { className: 'nodo-question-card', 'aria-labelledby': `nodo-question-${card.id}` },
      h('header', { className: 'nodo-question-head' },
        h('div', null,
          h('div', { className: 'nodo-question-eyebrow', role: 'alert' }, card.taskTitle ?? question.header ?? '等待回答'),
          h('h2', { className: 'nodo-question-title', id: `nodo-question-${card.id}` }, question.question))),
      h('div', { className: 'nodo-question-body' },
        h('div', { className: 'nodo-question-options', role: 'radiogroup', 'aria-label': question.header ?? question.question },
          ...(question.options ?? []).map((option, index) => {
            const display = optionText(option.label)
            return questionOption({ key: `${option.label}-${index}`, index, selected: draft === option.label, disabled: blocked,
              onClick: () => { setError(''); pick(option.label) }, label: display.text, recommended: display.recommended,
              line: option.description && h('span', { className: 'nodo-question-description' }, option.description) })
          })),
        question.allowText !== false && card.detail?.allowText !== false && questionAnswer({
          value: draft, disabled: blocked, label: question.header ?? question.question, placeholder: '输入你的答案',
          onChange: value => { setError(''); pick(value) }, onEnter: next,
        })),
      h('footer', { className: 'nodo-question-foot' },
        questionPager({ step, count: questions.length, disabled: blocked, onBack: () => { setError(''); setStep(step - 1) }, onNext: next }),
        h('p', { className: 'nodo-question-feedback', role: 'status' }, error),
        h('div', { className: 'nodo-question-actions' },
          h(Button, { variant: 'primary', disabled: blocked, onClick: next }, busy ? '提交中…' : last ? '提交' : '下一题')))))
}

// Unsent answers outlive a reload, keyed by decision; the page drops those of
// decisions that are no longer pending.
const DECISION_DRAFTS = 'nodo.decisionDrafts'
const readDecisionDrafts = () => { try { return JSON.parse(localStorage.getItem(DECISION_DRAFTS)) ?? {} } catch { return {} } }
const writeDecisionDraft = (id, draft) => {
  const { [id]: _old, ...rest } = readDecisionDrafts()
  try { localStorage.setItem(DECISION_DRAFTS, JSON.stringify(draft ? { ...rest, [id]: draft } : rest)) } catch {}
}
export const pruneDecisionDrafts = decisions => {
  const drafts = readDecisionDrafts()
  const stale = Object.keys(drafts).filter(id => !decisions.some(decision => decision.id === id && decision.status === 'pending'))
  if (stale.length > 0) try { localStorage.setItem(DECISION_DRAFTS, JSON.stringify(Object.fromEntries(Object.entries(drafts).filter(([id]) => !stale.includes(id))))) } catch {}
}
const DECISION_HEAD = { pending: '等待用户决定', answered: '答案已提交 · 等待交接' }

export function DecisionCard({ decision, profileId, readOnly, refresh, profiles = [], tasks = [], work = {} }) {
  const [saved] = useState(() => readDecisionDrafts()[decision.id] ?? { answers: {}, open: true, step: 0 })
  const [answers, setAnswersState] = useState(saved.answers)
  const [open, setOpenState] = useState(saved.open)
  const [step, setStepState] = useState(saved.step)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [feedback, setFeedback] = useState('')
  const remember = patch => writeDecisionDraft(decision.id, { answers, open, step, ...patch })
  const setAnswers = next => { setAnswersState(next); remember({ answers: next }) }
  const setOpen = next => { setOpenState(next); remember({ open: next }) }
  const setStep = next => { setFeedback(''); setStepState(next); remember({ step: next }) }
  const pending = decision.status === 'pending'
  const values = pending ? answers : decision.answer?.values ?? {}
  const blocked = busy || readOnly || !pending
  const answered = question => values[question.id]?.text?.trim()
    || question.options?.some(option => option.id === values[question.id]?.optionId)
  const complete = decision.questions.every(answered)
  const act = async (endpoint, payload) => {
    if (busy || readOnly) return
    setBusy(true)
    setFeedback('')
    try {
      const result = await call(endpoint, { profile: profileId, session: decision.coordinatorSessionId, decisionId: decision.id, ...payload })
      if (result?.status !== (endpoint === 'decision-answer' ? 'answered' : 'cancelled')) setFeedback(result?.message ?? '')
      if (result?.status !== 'pending') writeDecisionDraft(decision.id)
    } catch (failure) { setFeedback(failure.message) }
    setBusy(false)
    setConfirming(false)
    await refresh(true)
  }
  const roleName = sessionId => profiles.find(role => role.sessions?.some(session => session.id === sessionId))
  const running = (decision.runningExecutions ?? []).map(execution => ({ ...execution,
    active: work[execution.sessionId]?.active ?? execution.active, stopping: work[execution.sessionId]?.stopping ?? execution.stopping }))
    .filter(execution => execution.active || execution.stopping)
  const linked = decision.taskIds.map(id => tasks.find(task => task.id === id)).filter(Boolean)
  const tag = (text, tone) => h('span', { className: 'nodo-tag', 'data-tone': tone }, text)
  const count = decision.questions.length
  const at = Math.min(step, count - 1)
  const last = at === count - 1
  const question = decision.questions[at]
  const value = values[question.id]
  const choices = question.options ?? []
  const custom = value?.text !== undefined || choices.length === 0
  const choose = next => { setFeedback(''); setAnswers({ ...answers, [question.id]: next }) }
  const submit = () => void act('decision-answer', { answers: Object.fromEntries(decision.questions.map(item => [item.id, values[item.id]])) })
  const next = () => {
    if (!pending) return setStep(at + 1)
    if (!answered(question)) return setFeedback('请先完成这道问题。')
    if (!last) setStep(at + 1)
    else if (complete) submit()
  }

  return h('div', { className: 'nodo-question-frame' },
    h('section', { className: 'nodo-question-card nodo-decision', 'aria-labelledby': `nodo-decision-${decision.id}`, 'aria-busy': busy ? 'true' : undefined },
      h('header', { className: 'nodo-question-head' },
        h('div', { className: 'nodo-decision-heading' },
          h('div', { className: 'nodo-decision-status', role: 'status', id: `nodo-decision-${decision.id}` },
            h(StateDot, { state: pending ? 'warning' : 'ongoing', size: 7 }),
            decision.status === 'answered' && decision.handoffStopped ? '答案已提交 · 主控已停止' : DECISION_HEAD[decision.status]),
          (linked.length > 0 || running.length > 0) && h('div', { className: 'nodo-decision-meta' },
            ...linked.map(task => h('span', { key: task.id, className: 'nodo-tag', title: task.title }, task.title)),
            ...running.map(execution => {
              const role = roleName(execution.sessionId)
              const word = execution.stopping ? '停止中' : decision.stopExecutionIds.includes(execution.executionId) ? '停止未确认' : '运行中'
              return h('span', { key: execution.executionId, className: 'nodo-decision-run' },
                role && h(RoleAvatar, { profile: role, size: 16 }), tag(`${role?.name ?? execution.sessionId} · ${word}`, 'caution'))
            }))),
        h('button', { type: 'button', className: 'nodo-question-icon nodo-decision-toggle', 'aria-expanded': open,
          'aria-label': open ? '收起' : '展开', onClick: () => setOpen(!open) }, h(IconChevronDownOutlineRegular, { size: 16 }))),
      open && h('div', { className: 'nodo-question-body nodo-decision-body', role: 'group', 'aria-labelledby': `nodo-decision-q-${decision.id}` },
        h('h2', { className: 'nodo-question-title', id: `nodo-decision-q-${decision.id}` }, question.question),
        h('p', { className: 'nodo-decision-why' }, question.whyUser),
        choices.length > 0 && h('div', { className: 'nodo-question-options', role: 'radiogroup', 'aria-label': question.question },
          ...choices.map((option, index) => {
            const recommended = question.recommendation?.optionId === option.id
            return questionOption({ key: option.id, index, selected: value?.optionId === option.id, disabled: blocked,
              onClick: () => choose({ optionId: option.id }), label: option.label, recommended },
            h('span', { className: 'nodo-decision-consequence' }, option.consequence),
            recommended && h('span', { className: 'nodo-decision-reason' }, question.recommendation.reason))
          }),
          questionOption({ key: 'custom', index: choices.length, selected: custom, disabled: blocked, label: '自定义回答',
            onClick: () => choose({ text: value?.text ?? '' }) })),
        custom && questionAnswer({ value: value?.text ?? '', disabled: blocked, label: `${question.question} 自定义回答`,
          placeholder: '输入你的答案', key: question.id, autoFocus: pending, onChange: text => choose({ text }), onEnter: next })),
      open && h('footer', { className: 'nodo-question-foot' },
        questionPager({ step: at, count, disabled: busy, onBack: () => setStep(at - 1), onNext: next }),
        h('p', { className: 'nodo-question-feedback', role: 'alert' }, feedback),
        pending && h('div', { className: 'nodo-question-actions' },
          confirming
            ? [h(Button, { key: 'back', variant: 'outline', disabled: busy, onClick: () => setConfirming(false) }, '返回'),
              h(Button, { key: 'confirm', variant: 'outline', className: 'nodo-approval-reject', disabled: busy || readOnly, onClick: () => void act('decision-cancel', {}) }, '确认撤销')]
            : h(Button, { variant: 'outline', className: 'nodo-approval-reject', disabled: busy || readOnly, onClick: () => setConfirming(true) }, '撤销'),
          !confirming && (last
            ? h(Button, { variant: 'primary', disabled: busy || readOnly || !complete, onClick: submit }, busy ? '提交中…' : '提交')
            : h(Button, { variant: 'primary', disabled: busy || readOnly, onClick: next }, '下一题'))))))
}
