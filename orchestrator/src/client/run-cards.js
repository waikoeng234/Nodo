import { h, Fragment, useState, call, Button, StateDot, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular } from './ui-shared.js'
import { Field } from './profile-dialogs.js'
import { RunningLine } from './running.js'
import { RoleAvatar } from './avatar.tsx'
import { engineDisplayName } from './engine-logos.js'

// A pending request takes the host's own composer takeover for the same thing:
// a permission is the host's approval panel (warning strip, headline, reject /
// allow once, Enter and Escape as shortcuts), a question is the host's question
// composer (eyebrow + question, numbered options, custom answer, pager, submit).
// Workflow runs: a list of definitions to start and runs to open, and one run's
// steps with what a person can do about the step the run stopped on.
export const RUN_STATUS = { running: '运行中', waiting_human: '等待人工', paused: '已暂停', needs_reconcile: '待核对', done: '已完成', failed: '失败',
  cancelled: '已取消', unreadable: '无法读取', pending: '待调度', active: '执行中' }
export const RUN_DOT = { running: 'ongoing', active: 'ongoing', waiting_human: 'warning', paused: 'warning', needs_reconcile: 'warning', done: 'done', failed: 'error', unreadable: 'error' }
const RUN_REASONS = { interrupted: '执行中断', host_restarted: '宿主重启', workspace_occupied: '项目被占用', workspace_missing: '项目已删除', stop_unconfirmed: '停止未确认',
  end_unconfirmed: '结束未确认', profile_missing: '角色已删除', profile_changed: '角色配置已变', no_exit: '没有出口', blocked: '无法继续', back_limit: '返工次数已满', timeout: '超时',
  empty_reply: '空回复', missing_deliverable: '没有最终交付', cancelled: '已取消', no_pending_task: '没有待执行的步骤' }
const REASON_PRESETS = ['原执行已结束', '已人工核对']
const REASON_WORDS = { retry: '重试：', accepted: '已接受：', cancelled: '已放弃：' }
const ATTEMPT_PHASE = { dispatching: '投递中', running: '执行中', parsing: '解析中', ended: '已结束', cancelling: '停止中', interrupted: '已中断' }
const ATTEMPT_END = { done: '完成', error: '出错', interrupted: '中断', timeout: '超时' }
const SETTLE = ['needs_reconcile', 'waiting_human']
const STOPPABLE_RUN = ['running', 'waiting_human', 'paused', 'needs_reconcile']
export const needsPerson = run => SETTLE.includes(run.status)
export const taskName = task => ({ start: '开始', end: '结束' })[task.kind] ?? task.name
const OUTPUT_KINDS = ['agent', 'human']
const reasonText = reason => RUN_REASONS[reason] ?? String(reason ?? '').replace(/^(retry|accepted|cancelled): /, (_, word) => REASON_WORDS[word])
export const statusLine = (status, reason) => h('span', { className: 'nodo-runs-meta' },
  h(StateDot, { state: RUN_DOT[status] ?? 'idle', size: 10 }), RUN_STATUS[status] ?? status, reason && reasonText(reason) !== (RUN_STATUS[status] ?? status) ? ` · ${reasonText(reason)}` : '')
const attemptText = attempt => attempt.end
  ? `${ATTEMPT_END[attempt.end.reason] ?? attempt.end.reason}${attempt.end.unconfirmed ? '（未确认）' : ''}`
  : ATTEMPT_PHASE[attempt.phase] ?? attempt.phase

export function RunDetail({ run, work, draft, busy, readOnly, canOpen, onDraft, onAct, onOpenSession, exitHint, answerHint, step = false, onPick }) {
  if (run.status === 'unreadable') return h('section', { className: 'nodo-run', 'aria-label': '运行详情' },
    h('p', { className: 'nodo-dialog-hint' }, '这条运行记录无法读取，文件保持原样。'))
  const settle = run.tasks.find(task => task.id === run.settle)
  const accepts = OUTPUT_KINDS.includes(settle?.kind)
  const last = settle?.attempts.at(-1)
  const blocked = Boolean(busy) || readOnly
  const reason = draft.reason.trim()
  const choices = settle?.kind === 'human' ? answerHint?.length ? answerHint.map(label => ({ id: label, label })) : null : exitHint?.length > 1 ? exitHint : null
  const picked = settle?.kind === 'human' ? draft.text : draft.exit
  const accepted = settle?.kind === 'agent' && choices && picked ? `${draft.text.replace(/\n?[ \t]*NEXT:.*\s*$/, '').trim()}\nNEXT: ${picked}` : draft.text
  const open = attempt => h(Button, { variant: 'outline', size: 'sm', disabled: Boolean(busy) || !canOpen(attempt), onClick: () => onOpenSession(attempt) }, '打开会话')
  const running = (attempt, live = work?.[attempt?.sessionId]) => live?.active && !attempt.end
    && h(RunningLine, { key: attempt.sessionId, since: live.since, engine: live.engine })
  const state = task => task.card ? h('span', { className: 'nodo-runs-meta' }, h(StateDot, { state: 'warning', size: 10 }), '等待回答') : statusLine(task.status, task.reason)
  return h('section', { className: 'nodo-run', 'aria-label': '运行详情' },
    onPick && h('ol', { className: 'nodo-run-steps' }, ...run.tasks.map((task, index) => h('li', { key: task.id },
      h('button', { type: 'button', className: 'nodo-run-step', 'data-state': task.card ? 'warning' : RUN_DOT[task.status] ?? 'idle', onClick: () => onPick(task.id) },
        h('span', { className: 'nodo-run-step-mark', 'aria-hidden': true }, index + 1),
        h('span', { className: 'nodo-run-step-copy' }, h('strong', null, taskName(task)),
          h('small', null, [task.kind === 'human' ? '人工节点' : task.attempts.at(-1)?.profileName ?? '执行节点', task.attempts.length > 1 && `第 ${task.attempts.length} 次`,
            task.reason && !task.card && reasonText(task.reason)].filter(Boolean).join(' · '))),
        h('span', { className: 'nodo-run-step-state' }, task.card ? '等待回答' : RUN_STATUS[task.status] ?? task.status))))),
    ...(onPick ? [] : run.tasks).map(task => h('div', { key: task.id, className: 'nodo-run-task' },
      h('div', { className: 'nodo-run-line' }, h('strong', null, taskName(task)), state(task),
        task.provenance === 'human' && h('span', { className: 'nodo-tag' }, '人工产出')),
      task.input && h('div', { className: 'nodo-run-input' }, h('span', { className: 'nodo-runs-meta' }, '输入任务'),
        h('p', { className: 'nodo-run-output' }, task.input.text || '（无文字说明）'),
        task.input.attachments && h('span', { className: 'nodo-runs-meta' }, `附件：${task.input.attachments.join('、')}`)),
      ...task.attempts.map(attempt => h('div', { key: attempt.id, className: 'nodo-run-attempt' },
        h('span', null, `第 ${attempt.n} 次 · ${attempt.profileName ?? attempt.profileId} · ${attemptText(attempt)}`),
        attempt.sessionId && open(attempt))),
      running(task.attempts.at(-1)),
      task.output !== undefined && h('div', { className: 'nodo-run-result' }, h('span', { className: 'nodo-runs-meta' }, '步骤产出'),
        h('p', { className: 'nodo-run-output' }, task.more ? `${task.output}…` : task.output)))),
    settle && h('div', { className: 'nodo-run-task', role: 'group', 'aria-label': '人工核对' },
      h('p', { className: 'nodo-dialog-hint' }, `“${taskName(settle)}”停在这里。${settle.kind !== 'agent' ? '核对原问题与已有产出后选择处理方式。'
        : run.status === 'needs_reconcile' ? '先打开原会话确认原执行已结束，再重试或接受产出。' : '重试会在原会话继续，原会话不可用时新建。'}`),
      run.status === 'waiting_human' && /^not sent: Workflow handoff context exceeds \d+ characters;/.test(settle.reason ?? run.reason ?? '')
        && h('p', { className: 'nodo-dialog-hint' }, '交接内容超出预算，当前步骤尚未发送；重试不会改变本次运行的流程快照。可补充并接受人工产出（由你承担这一步的核验），或取消运行、缩短交接设置后重新启动。'),
      h(Field, { label: '理由' }, h('input', { className: 'nodo-dialog-input', value: draft.reason, maxLength: 500, disabled: blocked, placeholder: '记入运行记录',
        onChange: event => onDraft({ ...draft, reason: event.target.value }) })),
      h('div', { className: 'nodo-run-presets' }, ...REASON_PRESETS.map(text => h(Button, { key: text, variant: 'ghost', size: 'sm', disabled: blocked,
        'aria-pressed': draft.reason === text, onClick: () => onDraft({ ...draft, reason: text }) }, text))),
      accepts && choices && h('div', { className: 'nodo-run-exits', role: 'radiogroup', 'aria-label': settle.kind === 'human' ? '选择的选项' : '下一步出口' },
        ...choices.map(choice => h('label', { key: choice.id }, h('input', { type: 'radio', name: `nodo-exit-${settle.id}`, checked: picked === choice.id, disabled: blocked,
          onChange: () => onDraft(settle.kind === 'human' ? { ...draft, text: choice.id } : { ...draft, exit: choice.id }) }), choice.label))),
      accepts && !(settle.kind === 'human' && choices) && h(Field, { label: '接受的产出' }, h('textarea', { className: 'nodo-dialog-input nodo-dialog-textarea', value: draft.text, disabled: blocked,
        placeholder: '接受时填写这一步的产出', onChange: event => onDraft({ ...draft, text: event.target.value }) })),
      accepts && !choices && !exitHint && h('p', { className: 'nodo-dialog-hint' }, settle.kind === 'human'
        ? '人工节点须填写其中一个选项的文字，请核对原问题。' : '多出口步骤的产出最后一行须写 NEXT: <出口>。'),
      h('div', { className: 'nodo-run-actions' },
        last?.sessionId && open(last),
        h(Button, { variant: 'outline', size: 'sm', disabled: blocked || reason === '', onClick: () => onAct('run-reconcile', { action: 'retry', reason }) }, '重试'),
        accepts && h(Button, { variant: 'primary', size: 'sm', disabled: blocked || reason === '' || draft.text.trim() === '' || Boolean(choices && !picked),
          onClick: () => onAct('run-reconcile', { action: 'accept', text: accepted, reason }) }, '接受产出'))),
    !step && STOPPABLE_RUN.includes(run.status) && h('div', { className: 'nodo-run-actions' },
      run.status === 'needs_reconcile'
        ? h(Button, { variant: 'outline', size: 'sm', disabled: blocked || reason === '', title: '填写理由后放弃，视为确认原执行已结束',
          onClick: () => onAct('run-cancel', { reason }) }, '放弃运行')
        : h(Button, { variant: 'outline', size: 'sm', disabled: blocked, onClick: () => onAct('run-cancel', {}) }, busy === 'run-cancel' ? '正在取消…' : '取消运行')),
    busy === 'run-cancel' && h('p', { className: 'nodo-dialog-status', role: 'status' }, '正在等 Agent 确认停止…'))
}

const RECOMMENDED_LABEL = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i
// The host marks a recommended option inside the label itself; the badge is
// decoration, and the raw label stays the answer the engine receives.
const optionText = label => RECOMMENDED_LABEL.test(label)
  ? { text: label.replace(RECOMMENDED_LABEL, ''), recommended: true }
  : { text: label, recommended: false }

// A workflow question: read the step's report, then take one of the exits with an
// optional note, or send the report back to its step with what to change.
export function DecisionCard({ card, refresh, readOnly }) {
  const { exits, back, report, legacy } = card.detail
  const [exit, setExit] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const blocked = busy || readOnly
  const answer = async (picked) => {
    if (blocked) return
    if (!picked) return setError('请选择一个选项。')
    if (picked === '$back' && note.trim() === '') return setError('退回前请写明需要修改的内容。')
    setBusy(true)
    setError('')
    try {
      await call('approval-answer', { id: card.id, decision: 'answer', exit: picked, value: note })
      await refresh(true)
    } catch (failure) { setError(failure.message); setBusy(false); await refresh(true) }
  }
  return h('div', { className: 'nodo-question-frame' },
    h('section', { className: 'nodo-question-card', 'aria-labelledby': `nodo-question-${card.id}` },
      h('header', { className: 'nodo-question-head' },
        h('div', null,
          h('div', { className: 'nodo-question-eyebrow', role: 'alert' }, '等待你的决定'),
          h('h2', { className: 'nodo-question-title', id: `nodo-question-${card.id}` }, card.reason))),
      h('div', { className: 'nodo-question-body' },
        report && h('div', { className: 'nodo-question-report', role: 'group', 'aria-label': `${report.step} 的产出` },
          h('span', { className: 'nodo-runs-meta' }, `${report.step} 的产出`),
          h('p', { className: 'nodo-run-output' }, report.more ? `${report.text}…` : report.text)),
        legacy ? h('p', { className: 'nodo-dialog-hint', role: 'note' },
            `这条运行由旧版本启动，问题以自由文本作答，升级后不再支持；${back ? `可退回「${back}」重做，或` : ''}取消这条运行。`)
          : h(Fragment, null,
        h('div', { className: 'nodo-question-options', role: 'radiogroup', 'aria-label': card.reason },
          ...exits.map((item, index) => h('button', {
            key: item.id, type: 'button', role: 'radio', 'aria-checked': exit === item.id,
            className: 'nodo-question-option', 'data-selected': exit === item.id ? '' : undefined,
            disabled: blocked, onClick: () => { setError(''); setExit(item.id) },
          },
          h('span', { className: 'nodo-question-number', 'aria-hidden': true }, index + 1),
          h('span', { className: 'nodo-question-copy' }, h('span', { className: 'nodo-question-line' }, h('span', { className: 'nodo-question-label' }, item.label)))))),
        h('textarea', {
          className: 'nodo-question-answer', rows: 2, disabled: blocked, value: note, 'aria-label': '附言',
          placeholder: back ? `附言（可选），随选项交给下一步；退回「${back}」时写明需要修改的内容` : '附言（可选），随选项交给下一步',
          onChange: event => { setError(''); setNote(event.target.value) },
        }))),
      h('footer', { className: 'nodo-question-foot' },
        h('p', { className: 'nodo-question-feedback', role: 'status' }, error),
        h('div', { className: 'nodo-question-actions' },
          back && h(Button, { variant: 'outline', disabled: blocked, title: `把附言交回「${back}」重做，完成后回到这里`, onClick: () => void answer('$back') }, `退回「${back}」`),
          !legacy && h(Button, { variant: 'primary', disabled: blocked, onClick: () => void answer(exit) }, busy ? '提交中…' : '提交')))))
}

export function ApprovalCard({ card, refresh, readOnly, from }) {
  if (card.detail?.exits) return h(DecisionCard, { card, refresh, readOnly })
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
