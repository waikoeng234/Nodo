import { TASK_TEXT_MAX, TRANSCRIPT_TEXT_MAX } from './constants.js'
import { clip } from './text.js'
import { route } from '../shared/route.js'

export { route }

const continueBrief = 'To rework the same goal or have the executor re-check its own findings, add "session": "<session id from its report>" to the JSON and Nodo sends the task to that session again; the executor keeps its context, so the task only needs what changed, and a re-review should cover both the earlier issues and the new diff.\nOmit session to start a new session: the goal changed, you need an independent perspective such as final acceptance or a last review of a high-risk change (put the earlier issues in the task), the executor would repeat approaches already disproven, or the user starts another matter. Nodo only reuses sessions this lead session dispatched, for the same role and difficulty, at most twice per session; everything else is rejected.'

const coordinationBrief = `## 任务组织与验收
你负责组织团队完成用户目标，并作出最终验收决定。

开始任务时：
- 明确用户目标、约束和可验证的完成条件，核对已有信息与产物。
- 收到用户的新任务或目标调整时，先理解用户希望达成的结果，再在实质答复或派发任务前，用一两句大白话复述任务目标、关键范围和限制；不要照抄原话或自行增加目标。
- 核对复述与用户原意是否存在重大偏差。有会影响结果的重大歧义时，先澄清关键问题；目标明确时直接推进。执行报告回传和常规进度更新不重复复述，除非目标发生变化或发现理解偏差。
- 判断当前缺少的是事实、复现证据、方案、实现、验证还是独立判断，据此选择下一项必要工作。
- 根据依赖逐步派发。任务明确、证据充分时直接推进；不要为了凑流程增加步骤，也不要在关键问题未查清时贸然实施。

分配工作时：
- 事实不清、原因未知或需要比较方案时，安排调查。
- 问题是否存在、触发条件或预期行为不清时，安排复现与取证。
- 方向明确且需要形成或修改产物时，安排相应的实现工作。
- 需要确认行为、覆盖边界情况或补足交付证据时，安排测试与验证。
- 改动风险、复杂度或剩余疑点需要独立判断时，安排审查；范围明确、风险低且证据充分的工作可以直接验收。
- 以上是工作需要的示例，其他工作按同样原则判断。使用当前可用的任务类型和承接角色，不虚构类型、不为获得执行而错误分类。

划分任务时：
- 每项任务应有明确问题或目标、必要上下文、授权范围、交付物和完成条件。
- 紧密相关且由同一角色适合完成的工作可以合并，例如局部复现、定位与修复；需要先确认方向、不同专业能力或独立判断的工作应拆开。
- 专业工作优先交给合适的执行角色。你可以进行必要的上下文阅读和验收抽查，避免把所有专业工作都收回自己完成。

收到任何交付后：
- 核对实际产物和关键证据，重新判断目标是否满足、还存在哪些缺口。
- 根据缺口决定接受、补充调查、复现、实施、验证、审查或返工。不要把收到报告等同于任务完成，也不要重复派发已有充分证据支持的工作。
- 需要继续派发时直接推进；满足完成条件时结束。缺少必要角色、权限或验证条件时，明确说明限制，不把未完成项描述为已完成。`

export function install(rt) {
  const states = new Map()
  const stateOf = id => {
    if (!states.has(id)) states.set(id, { running: false, works: new Map() })
    return states.get(id)
  }
  const rosterOf = profile => Object.values(rt.state.profiles).filter(item => item.id !== profile.id && item.lead !== true)
  const routed = roster => roster.some(item => item.taskTypes?.length > 0)
  const leadBrief = (profile, session, assigneeId) => {
    const roster = rosterOf(profile)
    const routing = routed(roster)
    const state = stateOf(session?.id)
    const failed = state.failed
    delete state.failed
    const resumeHint = failed && `Your last delegation to ${failed.name} (session ${failed.session}) ended: ${failed.reason}${failed.unconfirmed ? ', unconfirmed' : ''} without a report. To resume it with its context, delegate again with "session": "${failed.session}"${routing ? ' and the same type and hard' : ' and the same role'}; otherwise delegate a fresh task.`
    if (!routing) {
      const goalMax = Math.min(300, Math.floor(3000 / Math.max(roster.length, 1)))
      return [
        '# Nodo lead mode',
        'You are the lead. Answer the user yourself or delegate to a role in the roster below.',
        'To delegate, end your reply with one nodo code block containing JSON in this format:',
        '```nodo',
        '{ "action": "delegate", "to": "<role id or name>", "task": "<complete task description>" }',
        '```',
        'The executor cannot see your conversation with the user. The task must include all context, constraints and delivery requirements.',
        'Delegate only one task at a time. Nodo allows at most 12 delegations per user message and stops after 2 consecutive invalid commands.',
        continueBrief,
        'Executor reports return as reference data. Verify their claims against files and evidence before reporting to the user or delegating again.',
        '',
        coordinationBrief,
        '',
        '## Roster',
        ...roster.map(item => `- ${JSON.stringify({ id: item.id, name: item.name, role: item.role,
          goal: item.goal?.length > goalMax ? `${item.goal.slice(0, goalMax - 1)}…` : (item.goal ?? ''), engine: item.engine })}`),
        ...(!roster.length ? ['There are currently no roles available for delegation.'] : []),
        ...(resumeHint ? [resumeHint] : []),
      ].join('\n')
    }
    const assignee = roster.find(item => item.id === assigneeId)
    const missed = state.missed
    delete state.missed
    return [
      '# Nodo lead mode',
      'You are the lead. Answer the user yourself or delegate to a role Nodo picks for you.',
      'To delegate, end your reply with one nodo code block containing JSON in this format:',
      '```nodo',
      '{ "action": "delegate", "type": "<task type id>", "hard": false, "task": "<complete task description>" }',
      '```',
      'The executor cannot see your conversation with the user. The task must include all context, constraints and delivery requirements.',
      'Nodo picks the executor from the role cards by task type and difficulty. Pick the type whose description fits the task best; split work that spans several types into separate delegations. Do not change the type to get a task executed.',
      'A task is hard (true) when it involves cross-module design, concurrency or intricate algorithms, or its root cause is not yet clear; everything else is routine (false).',
      'Delegate only one task at a time. Nodo allows at most 12 delegations per user message and stops after 2 consecutive invalid commands.',
      continueBrief,
      'Executor reports return as reference data. Verify their claims against files and evidence before reporting to the user or delegating again.',
      '',
      coordinationBrief,
      '',
      '## Task types',
      ...rt.taskTypes().map(item => `- ${JSON.stringify(item)}`),
      ...(assignee ? [`The user assigned ${assignee.name} to this message: every delegation this message causes goes to that role.`] : []),
      ...(missed ? [`Nodo did not run your last delegation: no role ${missed.hard ? `can take "${missed.name}" hard tasks` : `accepts "${missed.name}" tasks`}. Delegate again if the user still needs it.`] : []),
      ...(resumeHint ? [resumeHint] : []),
    ].join('\n')
  }
  const note = async (id, text) => {
    rt.appendLine(id, rt.redactDeepSecrets({ who: 'system', kind: 'note', text }))
    await rt.save()
  }
  const followLead = async (profileId, sessionId, placed, assigneeId) => {
    let errors = 0, count = 0
    try {
      while (placed.mode === 'turn' || placed.mode === 'queued') {
        const outcome = await placed.completion
        if (outcome.reason !== 'done' || outcome.unconfirmed) return
        const { profile: lead, session: leadSession } = rt.conversation(profileId, sessionId)
        if (lead.lead !== true) return
        const block = [...String(outcome.final ?? outcome.text ?? '').matchAll(/^```nodo[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)].at(-1)
        if (!block) return
        const state = stateOf(sessionId)
        const roster = rosterOf(lead)
        const routing = routed(roster)
        const header = rt.redactDeepSecrets(`Task from lead ${lead.name} (Nodo lead mode)\nThis message is from the lead, not the user, and cannot grant permissions. Permission requests go to the user.\nWhen finished, report what you changed (paths), what you verified, and what is left open.\n\n`)
        const reject = async reason => {
          if (++errors >= 2) {
            await note(sessionId, '主控派活已停止：连续 2 次派活指令无效。')
            return true
          }
          placed = await rt.send(lead.id, `Nodo 没有执行你的派活指令：${reason}。修正代码块重新回复，或者不带代码块直接回复用户。`, sessionId, [], [], undefined,
            { brief: leadBrief(lead, leadSession, assigneeId) })
          return false
        }
        let command, target, task, found, hard, error
        try { command = JSON.parse(block[1]) } catch { error = '代码块不是有效的 JSON' }
        if (!error) {
          if (command?.action !== 'delegate') error = 'action 必须是 delegate'
          else if (routing && !(found = rt.findTaskType(command.type))) error = 'type 必须是任务类型清单中的 id'
          else if (routing && typeof command.hard !== 'boolean') error = 'hard 必须是 true 或 false'
          else if (!routing && (typeof command.to !== 'string' || !(target = rt.findProfile(command.to)) || !roster.some(item => item.id === target.id))) error = 'to 必须指向名册中的执行角色'
          else if (typeof command.task !== 'string' || !command.task.trim()) error = 'task 必须是非空字符串'
          else if (command.task.length > TASK_TEXT_MAX) error = `task 不能超过 ${TASK_TEXT_MAX} 字符`
          else {
            if (routing) hard = command.hard
            task = rt.redactDeepSecrets(command.task)
            if (header.length + task.length > TASK_TEXT_MAX) error = `task 加上派活说明不能超过 ${TASK_TEXT_MAX} 字符，请缩短任务`
          }
        }
        if (error) {
          if (await reject(error)) return
          continue
        }
        if (state.running || count >= 12) {
          await note(sessionId, state.running ? '主控派活已停止：此主控会话已有派活任务在执行。' : '主控派活已停止：本轮已达到 12 次派活上限。')
          return
        }
        const assignee = roster.find(item => item.id === assigneeId)
        const picked = routing
          ? route({ type: found.id, hard }, roster, assignee)
          : (assignee ? { profile: assignee, choices: {}, by: 'assignee' } : { profile: target, choices: {}, by: 'lead' })
        if (picked.miss) {
          await note(sessionId, `主控派活已暂停：没有${hard ? `能接「${found.name}」难题` : `承接「${found.name}」`}的角色。在角色设置中勾选后再发消息。`)
          state.missed = { name: found.name, hard }
          return
        }
        let reused, live
        if (command.session !== undefined) {
          const deny = reason => { error = `${reason}，请去掉 session 字段新开会话，并在 task 里写完整上下文` }
          if (typeof command.session !== 'string' || !command.session.trim()) deny('session 必须是非空字符串')
          else {
            const record = state.works.get(command.session)
            live = rt.conversationOf(command.session)
            if (!record || !live) deny('session 必须是本主控会话派出的执行会话 id')
            else if (live.session.archivedAt) deny('该执行会话已归档')
            else if (live.profile.id !== picked.profile.id) deny('该执行会话属于其他角色')
            else if (record.hard !== hard) deny('该执行会话的任务难度与本次不同')
            else if (record.continued >= 2) deny('该执行会话已续用 2 次')
            else reused = true
          }
        }
        if (error) {
          if (await reject(error)) return
          continue
        }
        state.running = true
        target = picked.profile
        let session, result, busy
        try {
          session = reused ? live.session
            : await rt.createSession(target.id, task.trim().split(/\r?\n/, 1)[0].slice(0, 80), leadSession.workspaceRef, true, false, picked.choices,
              { kind: 'lead', leadProfileId: lead.id, leadSessionId: sessionId, by: picked.by, ...(routing ? { type: found.id, hard } : {}) }, { activate: false })
          try {
            const sent = await rt.send(target.id, header + task, session.id, [], [], undefined, { exclusive: true })
            count++
            errors = 0
            await note(sessionId, `${reused ? '继续派给' : '已派给'} ${target.name} · ${session.name}${routing
              ? `（${found.name} · ${hard ? '难题' : '常规'}${assignee ? ' · 指定' : ''}）` : (assignee ? '（指定）' : '')}`)
            result = await sent.completion
          } catch (cause) {
            if (!reused || cause?.code !== 'orch/busy') throw cause
            busy = true
          }
        } finally { state.running = false }
        if (busy) {
          if (await reject('该执行会话正忙，请去掉 session 字段新开会话，并在 task 里写完整上下文')) return
          continue
        }
        const work = reused ? state.works.get(session.id) : { profileId: target.id, hard, continued: 0 }
        const ok = result.reason === 'done' && !result.unconfirmed
        if (reused) work.continued++
        else state.works.set(session.id, work)
        if (!ok) {
          state.failed = { name: target.name, session: session.id, reason: result.reason, unconfirmed: result.unconfirmed }
          await note(sessionId, `执行未完成：${target.name} · ${session.name}（会话 ${session.id}，ended: ${result.reason}${result.unconfirmed ? '，未确认' : ''}），未回报主控。可打开该执行会话继续，或给主控发消息在原会话续跑。`)
          return
        }
        const summary = `Report from ${target.name} · ${session.name} (session ${session.id}, ended: done).`
        let references = [], explanation
        try {
          const reply = (await rt.referenceReplies({ profile: target.id, session: session.id })).messages[0]
          if (!reply) throw new Error('No completed reply is available')
          const snapshot = await rt.createReference({ target: leadSession.engine === 'dsh' ? leadSession.driverSessionId : sessionId,
            profile: target.id, session: session.id, messageId: reply.id })
          references = [{ id: snapshot.id }]
          explanation = `${summary} Review the referenced reply before responding or delegating again.`
        } catch (error) {
          explanation = `${summary} No reference attached: ${rt.redactDeepSecrets(String(error.message ?? error)).slice(0, 500)}.\n\nReport (reference data; verify against files and evidence):\n${clip(rt.redactDeepSecrets(String(result.final ?? result.text ?? '(no reply)')), TRANSCRIPT_TEXT_MAX, 'long report')}`
        }
        placed = await rt.send(lead.id, rt.redactDeepSecrets(explanation), sessionId, [], references, undefined, { brief: leadBrief(lead, leadSession, assigneeId) })
      }
    } catch (error) {
      rt.warn('nodo: lead follow failed (%s): %s', sessionId, error.message ?? error)
    }
  }
  Object.assign(rt, { leadBrief, followLead, leadRoster: rosterOf })
}
