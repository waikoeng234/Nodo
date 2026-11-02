import { ANSWER_TEXT_MAX } from './constants.js'
import { failure, invalid } from './errors.js'

export function install(rt) {
  /** @type {Map<string, {id:string, profileId:?string, name:?string, kind:'permission'|'question', tool:?string, reason:string, detail:any, at:number, answer:(choice:{decision:string, value?:string})=>void}>} */
  const pending = new Map()
  const answering = new Map()

  // A driver wants permission. The card settles; the engine is told.
  const openApproval = (profileId, event, onAnswered) => {
    if (typeof event?.id !== 'string' || event.id === '') return
    if (pending.has(event.id)) return
    const entry = {
      id: event.id,
      profileId,
      name: rt.conversationOf(profileId)?.profile.name ?? null,
      kind: event.kind === 'question' ? 'question' : 'permission',
      tool: typeof event.tool === 'string' ? event.tool : null,
      reason: String(event.reason ?? '').slice(0, 500),
      detail: event.detail ?? null,
      at: Date.now(),
      onAnswered,
    }
    pending.set(entry.id, entry)
    rt.notifyLive?.()
    // The card leaves at the first answer, so a second click cannot answer the
    // engine twice; it comes back only when the answer could not be delivered
    // and the engine has not closed the request meanwhile.
    entry.answer = async ({ decision, value }) => {
      if (!pending.delete(entry.id)) return
      rt.notifyLive?.()
      answering.set(entry.id, entry)
      let accepted
      try {
        accepted = await rt.answerRequest(profileId, entry.id, { decision, value })
      } catch (error) {
        if (!entry.closed) pending.set(entry.id, entry)
        rt.notifyLive?.()
        throw error
      } finally {
        rt.rearmIdle?.(profileId)
      }
      if (!accepted) throw failure('This engine request is no longer active', 'orch/stale')
    }
  }

  async function answerApproval(id, { decision, value } = {}) {
    id = String(id ?? '')
    const entry = pending.get(id)
    const typed = typeof value === 'string' && value.trim() !== ''
    if (entry === undefined) {
      throw failure('This card is no longer open', 'orch/stale')
    }
    if (entry.kind === 'permission' && decision !== 'allow' && decision !== 'deny') {
      throw invalid('Choose allow or deny')
    }
    if (entry.kind === 'question') {
      if (decision !== 'answer' || !typed) {
        throw invalid('Type an answer first')
      }
    }
    const reply = { decision, value: typeof value === 'string' ? value.slice(0, ANSWER_TEXT_MAX) : undefined }
    try {
      await entry.answer(reply)
      if (!entry.cancelled && decision === 'allow' && entry.tool === 'ExitPlanMode') {
        const found = rt.conversationOf(entry.profileId)
        if (['claude', 'codebuddy'].includes(found?.session?.engine) && (found.session.permission ?? found.profile.permission) === 'plan') {
          found.session.permission = 'workspace'
          await rt.save()
        }
      }
      answering.delete(entry.id)
      if (!entry.cancelled) await entry.onAnswered?.(reply)
      if (entry.profileId) void rt.flushLeadReports?.(entry.profileId)
    } finally { answering.delete(entry.id) }
  }

  // A profile gone or its driver disposed: settle its cards as denied so
  // the engine never keeps waiting on a screen that will not answer.
  const cancelApprovals = (profileId) => {
    for (const entry of [...pending.values(), ...answering.values()]) {
      if (entry.profileId !== profileId) continue
      const unanswered = pending.delete(entry.id)
      entry.closed = true
      entry.cancelled = true
      rt.driverSink?.(profileId, { type: 'request/closed', id: entry.id, cancelled: true })
      if (unanswered) void rt.answerRequest(profileId, entry.id,
        entry.kind === 'permission' ? { decision: 'deny' } : { decision: 'answer', value: '' }).catch(() => {})
    }
  }

  const approvalsView = () => [...pending.values()].map(({ id, profileId, name, kind, tool, reason, detail, at, answer }) =>
    ({ id, profileId, name, kind, tool, reason, detail, at, open: typeof answer === 'function' }))

  const closeApproval = id => {
    pending.delete(id)
    rt.notifyLive?.()
    const entry = answering.get(id)
    if (entry) entry.closed = true
  }
  const awaitingAnswer = profileId => [...pending.values()].some(entry => entry.profileId === profileId)

  const settlingAnswer = profileId => [...answering.values()].some(entry => entry.profileId === profileId)
  Object.assign(rt, { openApproval, answerApproval, cancelApprovals, approvalsView, closeApproval, awaitingAnswer, settlingAnswer })
}
