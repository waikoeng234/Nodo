import { randomUUID } from 'node:crypto'
import { validateWorkerReport } from '../../agent-drivers/dist/worker-mcp.js'
import { invalid } from './errors.js'

const firstConclusion = text => /^结论[:：](通过|不通过|done|blocked|failed)$/.exec((text ?? '').split(/\r?\n/, 1)[0].replace(/^[#*\-\s]+/, '').trim())?.[1]

export function install(rt) {
  rt.workerReport = async (execution, input) => {
    const validation = validateWorkerReport(input)
    if (!validation.valid) throw invalid(validation.errorMessage)
    const stage = execution.stage ?? 'implement'
    if (stage === 'review') {
      if (!input.verdict) throw invalid('审查必须提供 verdict')
      if (input.verdict === 'fail' && !input.findings?.length) throw invalid('审查 fail 必须提供 findings')
    } else if (input.verdict !== undefined || input.findings !== undefined) throw invalid('只有审查阶段可提供 verdict/findings')
    const questions = execution.questions ?? []
    if (questions.length) {
      const numbers = input.answers?.map(answer => answer.n) ?? []
      if (numbers.length !== questions.length || new Set(numbers).size !== questions.length
        || numbers.some(n => n > questions.length)) throw invalid('answers 必须按编号回答每个复核问题')
    } else if (input.answers !== undefined) throw invalid('没有复核问题，不能提供 answers')
    const report = rt.redactDeepSecrets({ ...input, id: randomUUID(), source: 'nodo_report', structured: true, at: Date.now() })
    if (execution.reportData) {
      const { id, at, summary } = execution.reportData
      execution.reportHistory = [...(execution.reportHistory ?? []), { id, at, summary }].slice(-3)
    }
    execution.reportData = report
    if (stage === 'review') {
      const source = rt.state.executions[execution.sourceExecutionId]
      if (source?.reportData && source.taskId === execution.taskId) {
        source.reportData.missedFlags = [...new Set((report.findings ?? []).map(item => item.category)
          .filter(category => category !== 'other' && source.reportData.reviewFlags?.[category] !== true))]
      }
    }
    await rt.saveStrict()
    return { ok: true, executionId: execution.id, reportId: report.id, stage }
  }
  rt.archiveWorkerReport = execution => {
    if (!execution.triggerId) return
    if (!execution.reportData || execution.reportData.source === 'final-text') {
      const conclusion = firstConclusion(execution.result?.text)
      const verdict = conclusion === '通过' ? 'pass' : conclusion === '不通过' ? 'fail' : undefined
      execution.reportData = { id: execution.reportData?.id ?? randomUUID(), source: 'final-text', structured: false,
        parse: execution.stage === 'review' && verdict ? 'first-line' : 'none',
        ...(execution.stage === 'review' && verdict ? { verdict } : {}), at: Date.now() }
    }
    const report = execution.reportData
    const workspace = rt.state.workspaces[execution.workspaceRef ?? rt.state.tasks[execution.taskId]?.workspaceRef]
    const files = execution.files ?? { items: [], total: 0, capture: 'unavailable', source: 'edit-tools' }
    const reported = (report.changed ?? []).map(item => item.path)
    execution.evidence = { ...(workspace?.worktree ? { branch: workspace.worktree.branch, baseCommit: workspace.worktree.baseCommit } : {}),
      files, reported, unreported: files.items.filter(item => !reported.includes(item.path)).map(item => item.path),
      verification: report.verified ?? [], reportCompleteness: report.structured ? 'complete' : execution.result?.completeness ?? 'unavailable', at: Date.now() }
  }
  rt.workerReportCard = execution => {
    const task = rt.state.tasks[execution.taskId], report = execution.reportData
    const stage = execution.stage ?? 'implement'
    const round = Object.values(rt.state.executions).filter(item => item.taskId === execution.taskId && (item.stage ?? 'implement') === stage
      && item.createdAt <= execution.createdAt).length
    const role = rt.conversationOf(execution.sessionId)?.profile.name ?? 'worker'
    const prior = rt.state.executions[execution.sourceExecutionId]
    const needsReview = ['implement', 'rework'].includes(stage) && (stage === 'rework' && prior?.stage === 'review' && prior.reportData?.verdict === 'fail'
      || !report.reviewFlags || Object.values(report.reviewFlags).some(Boolean)
      || !report.verified?.length || report.verified.some(item => item.result !== 'pass'))
    const conclusion = firstConclusion(execution.result?.text)
    const conflict = report.structured && (['done', 'blocked', 'failed'].includes(conclusion) && conclusion !== report.outcome
      || stage === 'review' && ['通过', '不通过'].includes(conclusion) && (conclusion === '通过') !== (report.verdict === 'pass'))
    const result = execution.result, files = execution.evidence?.files
    return [
      `[回报] ${role} · ${task.title.slice(0, 80)} · 阶段 ${stage}（第 ${round} 轮）`,
      `结论：${report.outcome ?? execution.status}${report.summary ? ` —— ${report.summary}` : ''}${report.verdict ? ` · ${report.verdict}` : ''}`,
      `Status: ${execution.status}${execution.reason && execution.reason !== execution.status ? ` · ${execution.reason}` : ''}`,
      `改动 ${files?.total ?? 0} 个文件${files?.source === 'workspace-snapshot' ? '（工作区快照，可能含其他改动）' : ''}（自报 ${report.changed?.length ?? 0}） / 验证 ${report.verified?.map(item => item.result).join('、') || '未运行'} / 自报风险 ${report.reviewFlags ? Object.entries(report.reviewFlags).filter(([, value]) => value).map(([key]) => key).join('、') || '无' : '未填写'} / 补充 ${execution.supplements?.length ?? 0} 条 / 未决项 ${report.issues?.length ?? 0}`,
      ...(!report.structured && result?.preview ? [`Result preview: ${result.preview}`] : []),
      `Completeness: ${result?.completeness ?? 'unavailable'}${result?.reason ? ` (${result.reason})` : ''}`,
      `报告：report:${report.id}   证据：evidence:${execution.id}   最终回复：nodo_context read executionId ${execution.id}`,
      `流程：${!report.structured ? '未结构化：审查将从首行读取结论' : needsReview ? '需要独立审查；复核后程序会派出。' : '等待复核。'}`,
      ...(conflict ? ['最终回复与报告不一致'] : []),
      ...(execution.evidence?.unreported.length ? [`未自报改动 ${execution.evidence.unreported.length} 项`] : []),
      ...(execution.supplementUnconfirmed ? ['补充未确认送达'] : []),
    ].join('\n')
  }
}
