import { leadModeOf } from '../../core/shared/lead.js'
import { until } from './host.js'

export async function reviewDeliveredReports(rt, sessionId) {
  const owner = rt.conversationOf(sessionId)
  if (!owner || !leadModeOf(owner.profile, owner.session) || owner.session.archivedAt) return
  await until(() => rt.transcriptOf(sessionId)
    .filter(line => line.origin?.kind === 'report' && line.origin.reviewRequired && line.origin.executionId)
    .every(({ origin }) => rt.state.executions[origin.executionId]?.reports?.some(report => report.id === origin.reportId)
      && !owner.session.reportQueue?.some(report => report.id === origin.reportId)))
  for (const execution of Object.values(rt.state.executions)) {
    const reports = execution.reports?.filter(report => !report.review)
    if (rt.state.tasks[execution.taskId]?.coordinatorSessionId !== sessionId || !reports?.length) continue
    await rt.leadTask(sessionId, { action: 'review', taskId: execution.taskId, executionId: execution.id, disposition: 'continue',
      reason: 'Fixture leader checked the result before continuing the authorized test task', basis: reports.map(report => report.id) })
  }
}
