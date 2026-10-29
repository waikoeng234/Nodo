import { h, useState, call, Button, StateDot, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular } from './ui-shared.js'
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
          h(StateDot, { state: busy ? 'ongoing' : 'warning' }), from ? '等待审批 ·' : '等待审批',
          from && h('span', { className: 'nodo-approval-from' }, h(RoleAvatar, { profile: from.role, size: 16 }),
            h('span', null, [from.role.name, from.role.engine && engineDisplayName({ id: from.role.engine }), from.session.name].filter(Boolean).join(' · ')))),
        h('div', { className: 'nodo-approval-body', tabIndex: 0, role: 'group', 'aria-label': '审批详情' },
          h('p', { className: 'nodo-approval-headline' }, card.tool ? `工具「${card.tool}」请求执行` : card.reason),
          card.tool && card.reason ? h('p', { className: 'nodo-approval-command' }, card.reason) : null),
        h('div', { className: 'nodo-approval-actions' },
          h(Button, { variant: 'outline', className: 'nodo-approval-reject', disabled: blocked, onClick: () => void answer('deny') }, '拒绝'),
          h(Button, { variant: 'primary', disabled: blocked, onClick: () => void answer('allow') }, '允许一次'))),
      error && h('p', { className: 'nodo-approval-error', role: 'alert' }, error))
  }

  return h('div', { className: 'nodo-question-frame' },
    h('section', { className: 'nodo-question-card', 'aria-labelledby': `nodo-question-${card.id}` },
      h('header', { className: 'nodo-question-head' },
        h('div', null,
          h('div', { className: 'nodo-question-eyebrow', role: 'alert' }, question.header ?? '等待回答'),
          h('h2', { className: 'nodo-question-title', id: `nodo-question-${card.id}` }, question.question))),
      h('div', { className: 'nodo-question-body' },
        h('div', { className: 'nodo-question-options', role: 'radiogroup', 'aria-label': question.header ?? question.question },
          ...(question.options ?? []).map((option, index) => {
            const display = optionText(option.label)
            return h('button', {
              key: `${option.label}-${index}`, type: 'button', role: 'radio', 'aria-checked': draft === option.label,
              className: 'nodo-question-option', 'data-selected': draft === option.label ? '' : undefined,
              disabled: blocked, onClick: () => { setError(''); pick(option.label) },
            },
            h('span', { className: 'nodo-question-number', 'aria-hidden': true }, index + 1),
            h('span', { className: 'nodo-question-copy' },
              h('span', { className: 'nodo-question-line' },
                h('span', { className: 'nodo-question-label' }, display.text),
                display.recommended && h('span', { className: 'nodo-tag', 'data-tone': 'accent' }, '推荐'),
                option.description && h('span', { className: 'nodo-question-description' }, option.description))))
          })),
        question.allowText !== false && card.detail?.allowText !== false && h('textarea', {
          className: 'nodo-question-answer', rows: 1, disabled: blocked, value: draft,
          'aria-label': question.header ?? question.question, placeholder: '输入你的答案',
          onChange: event => { setError(''); pick(event.target.value) },
          onKeyDown: event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); next() } },
        })),
      h('footer', { className: 'nodo-question-foot' },
        questions.length > 1 && h('div', { className: 'nodo-question-pager' },
          h('button', { type: 'button', className: 'nodo-question-icon', 'aria-label': '上一题', disabled: step === 0 || blocked,
            onClick: () => { setError(''); setStep(step - 1) } }, h(IconChevronLeftOutlineRegular, { size: 16 })),
          h('span', { className: 'nodo-question-progress' }, `${step + 1} / ${questions.length}`),
          h('button', { type: 'button', className: 'nodo-question-icon', 'aria-label': '下一题', disabled: last || blocked,
            onClick: next }, h(IconChevronRightOutlineRegular, { size: 16 }))),
        h('p', { className: 'nodo-question-feedback', role: 'status' }, error),
        h('div', { className: 'nodo-question-actions' },
          h(Button, { variant: 'primary', disabled: blocked, onClick: next }, busy ? '提交中…' : last ? '提交' : '下一题')))))
}
