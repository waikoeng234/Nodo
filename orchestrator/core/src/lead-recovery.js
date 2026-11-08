import { randomUUID } from 'node:crypto'

// Restart recovery for lead delegations: queued executions become unsent,
// running ones become unconfirmed, and any report the previous host had not
// delivered is queued again. The live flight map and helpers stay in lead.js.
export function createLeadRecovery(rt, { stateOf, flightOf, latestExecutions, recovering, removeUnsentWorktree, causeOf, queueReport, cancelDispatch, note, flushLeadReports, unreportedGone }) {
  return () => {
    if (rt.readOnly?.()) return
    const latest = latestExecutions()
    for (const execution of Object.values(rt.state.executions)) {
      if (flightOf(execution.sessionId) || recovering.has(execution.id)) continue
      if (execution.status === 'queued') {
        recovering.add(execution.id)
        void rt.cancelUnsentExecution(execution.id, { reason: 'restart-unsent' })
          .then(() => removeUnsentWorktree(execution.workspaceRef))
          .catch(error => rt.warn('nodo: queued cancellation failed (%s): %s', execution.id, causeOf(error)))
          .finally(() => recovering.delete(execution.id))
        continue
      }
      const session = rt.conversationOf(execution.sessionId)?.session
      if (execution.status === 'running' || execution.status === 'unconfirmed' && (session?.source?.pendingReport || !execution.report)) {
        recovering.add(execution.id)
        void (execution.status === 'unconfirmed' ? Promise.resolve() : rt.unconfirmExecution(execution.id, { reason: 'restart' })).then(async () => {
          const session = rt.conversationOf(execution.sessionId)?.session
          const owner = rt.conversationOf(rt.state.tasks[execution.taskId].coordinatorSessionId)
          if (!session?.source || !owner) return
          session.source.pendingReport ??= { id: randomUUID() }
          const placed = await queueReport(owner.profile.id, owner.session, session, { reason: execution.reason, unconfirmed: true }, session.source.pendingReport, execution)
          if (placed) void rt.followLead(owner.session.id, placed)
        }).catch(error => rt.warn('nodo: execution recovery failed (%s): %s', execution.id, causeOf(error)))
          .finally(() => recovering.delete(execution.id))
      }
    }
    for (const profile of Object.values(rt.state.profiles)) for (const session of profile.sessions ?? []) {
      if (latest.has(session.id)) continue
      if (session.source?.dispatch?.status === 'queued' && !flightOf(session.id)) {
        void cancelDispatch(stateOf(session.source.leadSessionId), { session: session.id, settle() {} })
          .catch(error => rt.warn('nodo: queued cancellation failed (%s): %s', session.id, causeOf(error)))
      }
      if (session.source?.dispatch?.status === 'running' && !flightOf(session.id)) {
        Object.assign(session.source.dispatch, { status: 'unconfirmed', reason: 'restart', endedAt: Date.now() })
        session.source.pendingReport ??= { id: randomUUID() }
      }
      if (session.source?.dispatch?.status === 'unconfirmed' && session.source.pendingReport && !flightOf(session.id)) {
        const owner = rt.conversationOf(session.source.leadSessionId)
        if (owner) void queueReport(owner.profile.id, owner.session, session,
          { reason: session.source.dispatch.reason, unconfirmed: true }, session.source.pendingReport)
          .then(placed => placed && rt.followLead(owner.session.id, placed))
          .catch(error => rt.warn('nodo: lead report failed (%s): %s', owner.session.id, error.message ?? error))
        else {
          delete session.source.pendingReport
          void note(session.id, unreportedGone)
        }
      }
    }
    for (const profile of Object.values(rt.state.profiles)) for (const session of profile.sessions ?? []) void flushLeadReports(session.id)
  }
}
