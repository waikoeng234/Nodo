// Approvals: every permission an engine asks for and every question a workflow
// needs answered becomes one card the user settles from the UI. The default is
// full pass-through to the human — nothing auto-allows. Driver `request/opened`
// events fill the pending set and are answered through the driver's
// respondToRequest. A workflow run's questions are kept apart: the run file is
// their record, the run rebuilds them after a restart and checks every answer.
import { ANSWER_TEXT_MAX } from './constants.js'

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
    // The card leaves at the first answer, so a second click cannot answer the
    // engine twice; it comes back only when the answer could not be delivered
    // and the engine has not closed the request meanwhile.
    entry.answer = async ({ decision, value }) => {
      if (!pending.delete(entry.id)) return
      answering.set(entry.id, entry)
      let accepted
      try {
        accepted = await rt.answerRequest(profileId, entry.id, { decision, value })
      } catch (error) {
        if (!entry.closed) pending.set(entry.id, entry)
        throw error
      } finally {
        answering.delete(entry.id)
        rt.rearmIdle?.(profileId)
      }
      if (!accepted) throw Object.assign(new Error('This engine request is no longer active'), { code: 'orch/stale' })
    }
  }

  // Cards a workflow run holds; it opens and drops them as its file changes.
  const held = new Map()
  // A run's question is answered by one of its exits, with an optional note as `value`.
  const holdQuestion = ({ id, name, question, detail, at }) => {
    if (held.has(id)) return
    held.set(id, { id, profileId: null, name, kind: 'question', tool: null, reason: String(question ?? '').slice(0, 500), detail, at, answer: ({ value, exit }) => rt.answerRunRequest(id, { exit, text: value }) })
  }

  async function answerApproval(id, { decision, value, exit } = {}) {
    id = String(id ?? '')
    const entry = pending.get(id) ?? held.get(id)
    const picked = typeof exit === 'string' && exit !== ''
    const typed = typeof value === 'string' && value.trim() !== ''
    if (entry === undefined) {
      // An answered run question stays on record, so the same answer sent again still succeeds.
      if (decision === 'answer' && (picked || typed) && await rt.answerRunRequest?.(id, { exit, text: typeof value === 'string' ? value.slice(0, ANSWER_TEXT_MAX) : '' })) return
      throw Object.assign(new Error('This card is no longer open'), { code: 'orch/stale' })
    }
    if (entry.kind === 'permission' && decision !== 'allow' && decision !== 'deny') {
      throw Object.assign(new Error('Choose allow or deny'), { code: 'orch/invalid' })
    }
    if (entry.kind === 'question') {
      if (decision !== 'answer' || !(typed || (picked && held.has(id)))) {
        throw Object.assign(new Error('Type an answer first'), { code: 'orch/invalid' })
      }
    }
    const reply = { decision, value: typeof value === 'string' ? value.slice(0, ANSWER_TEXT_MAX) : undefined }
    await entry.answer({ ...reply, ...(held.has(id) ? { exit } : {}) })
    if (!entry.cancelled) await entry.onAnswered?.(reply)
    if (entry.profileId) void rt.flushLeadReports?.(entry.profileId)
  }

  // A profile gone or its driver disposed: settle its cards as denied so neither
  // the engine nor a workflow keeps waiting on a screen that will not answer.
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

  const approvalsView = () => [...pending.values(), ...held.values()].map(({ id, profileId, name, kind, tool, reason, detail, at, answer }) =>
    ({ id, profileId, name, kind, tool, reason, detail, at, open: typeof answer === 'function' }))

  const closeApproval = id => {
    pending.delete(id)
    const entry = answering.get(id)
    if (entry) entry.closed = true
  }
  const awaitingAnswer = profileId => [...pending.values()].some(entry => entry.profileId === profileId)

  Object.assign(rt, { openApproval, holdQuestion, dropQuestion: id => held.delete(id), answerApproval, cancelApprovals, approvalsView, closeApproval, awaitingAnswer })
}
