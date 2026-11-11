import { leadModeOf } from '../shared/lead.js'
import { invalid } from './errors.js'
import { executionResultView } from './tasks.js'

// Read-only views over live delegation, role and task state. They share the
// lead module's live flight map and delegation summary, so they are built there
// and exposed through rt rather than installing a second module.
export function createLeadView(rt, { rosterOf, flightOf, delegationSummary, ownerOf, ownedTask }) {
  const latestExecutions = () => new Map(Object.values(rt.state.executions).map(execution => [execution.sessionId, execution]))
  const table = (columns, rows) => rt.redactDeepSecrets([columns, columns.map(() => '---'), ...rows]
    .map(row => `| ${row.map(value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ')).join(' | ')} |`).join('\n'))
  const delegationState = (profile, session, dispatch = delegationSummary(session)) => {
    const labels = { queued: '待发送', cancelled: '已取消', running: '执行中', done: '已完成', failed: '失败', interrupted: '已中断', 'interrupted-lead': '已中断（主控）', 'interrupted-user': '已中断（用户）', unconfirmed: '未确认' }
    let status = labels[dispatch.status] ?? dispatch.status
    if (dispatch.status === 'running') {
      const live = rt.dispatchWork?.(session.id)
      const native = session.engine === 'dsh' ? rt.nativeWork?.(session) : null
      const flight = flightOf(session.id)
      const waiting = session.engine === 'dsh' ? ['waiting-question', 'waiting-approval'].includes(native?.status) : rt.awaitingAnswer?.(session.id)
      const activity = flight?.stopping || live?.stopping ? '停止中'
        : flight?.waiting ? `等待自动续跑 ${flight.retries}/5`
          : live?.suspect ? '疑似卡住' : live?.retry ? '引擎重试中' : waiting ? '等待用户' : ''
      status += `${activity ? ` · ${activity}` : ''} · 已执行 ${Math.max(0, Math.floor((Date.now() - dispatch.acceptedAt) / 1000))} 秒`
    } else if (dispatch.status !== 'done' && dispatch.reason && dispatch.reason !== dispatch.status) status += ` · ${dispatch.reason}`
    if (dispatch.supplementUnconfirmed) status += ' · 补充未确认送达'
    return [session.id, profile.name, dispatch.task, `${dispatch.type} / ${dispatch.hard ? '难题' : '常规'}`, status, session.source.continued ?? 0, dispatch.directory ?? dispatch.branch ?? '共享']
  }
  const delegationsOf = (id, latest = latestExecutions()) => Object.values(rt.state.profiles).flatMap(profile => (profile.sessions ?? [])
    .filter(session => session.source?.kind === 'lead' && session.source.leadSessionId === id)
    .map(session => ({ profile, session, dispatch: delegationSummary(session, latest) })).filter(item => item.dispatch))
  const leadSnapshot = id => {
    const owner = rt.conversationOf(id)
    if (!owner || !leadModeOf(owner.profile, owner.session)) return ''
    const records = delegationsOf(id).sort((a, b) => b.dispatch.acceptedAt - a.dispatch.acceptedAt)
    const active = records.filter(item => ['queued', 'running'].includes(item.dispatch.status))
    const shown = active.length ? active : records.slice(0, 1)
    const all = rt.listDecisions?.(id) ?? []
    const recent = new Set(all.filter(item => !['pending', 'answered'].includes(item.status)).slice(-3))
    const decisions = all.filter(item => ['pending', 'answered'].includes(item.status) || recent.has(item))
      .map(({ id, status, taskIds, sourceExecutionIds }) => ({ decisionId: id, status,
        taskIds: [...new Set([...taskIds, ...sourceExecutionIds.map(id => rt.state.executions[id].taskId)])], sourceExecutionIds }))
    const cards = leadCards(id)
    const waiting = rt.sessionBlockReason?.(id)
    if (!shown.length && !decisions.length && !cards.length && !waiting) return ''
    return `<nodo-status>\n${shown.length ? table(['会话', '角色', '任务', '类型 / 难度', '状态', '已续用', '目录'], shown.map(item => delegationState(item.profile, item.session, item.dispatch))) + '\n' : ''}${waiting ? `等待原因：${JSON.stringify(waiting)}\n` : ''}${decisions.length ? `决策：${JSON.stringify(decisions)}\n` : ''}${cards.length ? `卡片：${JSON.stringify(cards)}\n` : ''}执行中的改动可能还没写进文件，不要据此判断任务没有执行。\n</nodo-status>`
  }
  const leadDelegations = (id, sessionId) => {
    const records = delegationsOf(id).sort((a, b) => (b.dispatch.endedAt ?? b.dispatch.acceptedAt) - (a.dispatch.endedAt ?? a.dispatch.acceptedAt))
    const recent = new Set(records.filter(item => item.dispatch.status !== 'running').slice(0, 10).map(item => item.session.id))
    const selected = records.filter(({ session, dispatch }) => sessionId ? session.id === sessionId
      : dispatch.status === 'running' || recent.has(session.id))
    if (sessionId && !selected.length) return '没有该执行会话的派活记录'
    return table(['会话', '角色', '任务', '类型 / 难度', '状态', '已续用', '目录'], selected.map(({ profile, session, dispatch }) => delegationState(profile, session, dispatch)))
  }
  const leadRoles = id => {
    const found = rt.conversationOf(id)
    if (!found || !leadModeOf(found.profile, found.session)) throw invalid('调用方必须是有效主控会话')
    const team = rt.teamOf(found.profile.id)
    if (!team) throw invalid('该主控还没有团队，请先在角色页建立团队')
    const nameOf = pick => pick?.profile ? rt.state.profiles[pick.profile]?.name ?? '' : ''
    const settings = pick => [pick?.model, pick?.thinking].filter(Boolean).join(' / ')
    return [table(['角色', '身份', '职责'], rosterOf(found.profile).map(item => [item.name, item.identity, item.role])),
      table(['id', 'name', 'when', '常规任务', '难题', '独立视角'], team.types.map(item => {
        const entry = team.assign[item.id]
        const split = entry?.hard !== undefined
        return [item.id, item.name, item.when, [nameOf(entry?.normal), settings(entry?.normal)].filter(Boolean).join(' · ') || '无人承接',
          split ? [nameOf(entry.hard), settings(entry.hard)].filter(Boolean).join(' · ') || '无人承接' : '同常规任务', item.independent ? '是' : '']
      })),
      '路由规则：每个任务类型在团队里有固定的承接角色；没有单独指定难题角色的类型，常规和难题都派给常规角色。没有承接角色就停止派活并说明缺口。后续任务按团队分配重新路由，角色或难度变化时由 Nodo 新开会话并自动交接上一执行结果。分配变更只影响之后的派活，不切换正在执行的会话。'].join('\n\n')
  }
  const leadTasks = async (id, taskId) => {
    await rt.load()
    const owner = ownerOf(id)
    if (taskId !== undefined) return ownedTask(owner, taskId)
    const summaries = new Map(Object.values(rt.state.tasks).filter(task => task.coordinatorSessionId === owner.session.id)
      .sort((a, b) => b.updatedAt - a.updatedAt).map(task => [task.id, { id: task.id, title: task.title, status: task.status,
        teamId: task.teamId, ...(task.parentId !== undefined ? { parentId: task.parentId } : {}),
        ...(task.dependsOn !== undefined ? { dependsOn: [...task.dependsOn] } : {}), executionCount: 0, latestExecutionStatus: null, references: [] }]))
    const pending = new Set()
    const latest = new Map()
    for (const execution of Object.values(rt.state.executions)) {
      const summary = summaries.get(execution.taskId)
      if (!summary) continue
      summary.executionCount++
      summary.latestExecutionStatus = execution.status
      latest.set(execution.taskId, execution)
      summary.references.push(...execution.references)
      if (['queued', 'running', 'unconfirmed'].includes(execution.status)) pending.add(execution.taskId)
    }
    const records = [...summaries.values()]
    const recent = new Set(records.filter(item => !pending.has(item.id)).slice(0, 10).map(item => item.id))
    return Promise.all(records.filter(item => pending.has(item.id) || recent.has(item.id)).map(async item => ({ ...item, references: [...new Set(item.references)],
      ...(latest.has(item.id) ? { latestResult: await executionResultView(latest.get(item.id), rt) } : {}) })))
  }
  const leadCards = id => {
    ownerOf(id)
    return rt.redactDeepSecrets(Object.values(rt.state.cards ?? {}).filter(card => card.coordinatorSessionId === id && card.status === 'open')
      .map(({ id, taskId, kind, status, question, createdAt }) => structuredClone({ id, taskId, kind, status, question, createdAt })))
  }
  return { delegationState, leadSnapshot, leadDelegations, leadRoles, leadTasks, leadCards }
}
