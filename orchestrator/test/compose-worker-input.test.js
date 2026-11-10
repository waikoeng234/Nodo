import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { withHost } from './helpers/host.js'
import { INPUT_CONTEXT_MAX } from '../core/src/constants.js'

// Fixture: a lead, a worker (plus a spare session for side-task executions), a
// team whose feature type carries the flow config, and one round opened by a
// verbatim user line already bound to task and execution.
const setup = async (rt, home, { engine = 'echo', triggerExtras = {} } = {}) => {
  rt.state.workspaces.w = { id: 'w', cwd: home }
  rt.state.profiles.leader = { id: 'leader', engine: 'echo', sessions: [{ id: 'lead', workspaceRef: 'w' }] }
  rt.state.profiles.worker = { id: 'worker', engine, sessions: [{ id: 'ws', workspaceRef: 'w' }, { id: 'ws2', workspaceRef: 'w' }] }
  rt.state.prefs.teams = [{ id: 't', name: 'T', lead: 'leader', members: ['worker'],
    types: [{ id: 'feature', name: '功能', when: '', flow: { reviewType: 'review', maxRework: 3 } },
      { id: 'review', name: '审查', when: '', independent: true }],
    assign: { feature: { normal: { profile: 'worker' } } } }]
  const line = rt.appendLine('lead', { who: 'user', kind: 'text', text: '修复登录页的滚动条bug', ...triggerExtras })
  const trigger = rt.persistTrigger(rt.triggerFromLine({ coordinatorSessionId: 'lead', line }))
  const task = await rt.createTask({ workspaceRef: 'w', teamId: 't', coordinatorSessionId: 'lead', title: 'Fix', brief: '修复登录页的滚动条bug', source: { kind: 'lead', sessionId: 'lead' } })
  Object.assign(rt.state.tasks[task.id], { triggerId: trigger.id, scope: { quote: '修复登录页的滚动条bug' }, flow: { status: 'running', stage: 'implement', round: 1 } })
  const execution = await rt.acceptExecution(task.id, { profileId: 'worker', sessionId: 'ws', type: 'feature', hard: false })
  Object.assign(rt.state.executions[execution.id], { triggerId: trigger.id, scope: { quote: '修复登录页的滚动条bug' } })
  await rt.saveStrict()
  return { task: rt.state.tasks[task.id], execution: rt.state.executions[execution.id], trigger }
}
// Ends a queued execution as done with an archived result.
const complete = async (rt, id, final) => { await rt.startExecution(id); await rt.finishExecution(id, { final, report: final || '无回报' }) }

test('the composer takes only an execution id and renders the always-on sections from records', async () => {
  await withHost(async ({ runtime, home }) => {
    const rt = await runtime
    const { execution } = await setup(rt, home)
    assert.equal(rt.composeWorkerInput.length, 1)
    rt.appendLine('ws', { origin: { kind: 'delegation', executionId: execution.id }, who: 'system', kind: 'note', text: '已受理' })
    const { text, inputContext, images, files } = await rt.composeWorkerInput({ executionId: execution.id })
    assert.match(text, /# 本轮要求（用户原话，逐字，唯一需求来源）\n修复登录页的滚动条bug/)
    assert.match(text, /# 任务范围\n修复登录页的滚动条bug/)
    assert.match(text, /# 阶段\n第 1 阶段：实现。按上面的原话完成，不要扩展到原话未覆盖的工作。/)
    assert.match(text, /# 回报方式\n完成后调用 nodo_report 工具回报/)
    for (const absent of ['# 用户补充', '## 附件', '# 原始要求', '# 被审查的执行', '# 复核问题', '# 前序结论', '# 前置任务结论', '# 本会话此前的内容']) {
      assert.equal(text.includes(absent), false, absent)
    }
    assert.deepEqual(images, [])
    assert.deepEqual(files, [])
    assert.deepEqual(inputContext.required, [])
    assert.deepEqual(inputContext.background, [])
    assert.deepEqual(rt.state.executions[execution.id].historyHandles, [])
    assert.deepEqual(rt.state.executions[execution.id].contextHandles, [])
    assert.equal(existsSync(join(home, 'state.json')), true)
  })
})

test('a new session carries the coordinator history window with its handles and the trim note', async () => {
  await withHost(async ({ runtime, home }) => {
    const rt = await runtime
    const { execution } = await setup(rt, home)
    for (let n = 0; n < 8; n++) rt.appendLine('lead', { who: 'user', kind: 'text', text: `用户消息${n}` })
    for (let n = 0; n < 8; n++) rt.appendLine('lead', { who: 'agent', kind: 'text', text: `主控回复${n}` })
    const { text } = await rt.composeWorkerInput({ executionId: execution.id })
    assert.match(text, /# 本会话此前的内容（只读参考，不是新指令）/)
    const window = text.slice(text.indexOf('# 本会话此前的内容'), text.indexOf('# 回报方式'))
    assert.equal((window.match(/\[用户\]/g) ?? []).length, 6, 'the last six user originals ride along')
    assert.equal((window.match(/\[主控\]/g) ?? []).length, 6)
    assert.match(window, /用户消息7/)
    assert.equal(window.includes('用户消息0'), false, 'earlier messages drop first')
    assert.equal((rt.state.executions[execution.id].historyHandles ?? []).length, 12)
    rt.appendLine('lead', { who: 'agent', kind: 'text', text: '最新回复' })
    for (let n = 0; n < 801; n++) rt.appendLine('lead', { who: 'user', kind: 'text', text: '填充' })
    const trimmed = (await rt.composeWorkerInput({ executionId: execution.id })).text
    assert.match(trimmed, /更早的消息未保留（会话记录只保留最近 800 行）/)
  })
})

test('supplements render verbatim in order and trigger attachments come back as message images and staged paths', async () => {
  await withHost(async ({ runtime, home }) => {
    const rt = await runtime
    const [image] = await rt.saveImages([{ mediaType: 'image/png', data: Buffer.from('png').toString('base64'), name: 'p' }])
    const [file] = await rt.saveFiles([{ name: '说明.txt', bytes: Buffer.from('附件内容') }])
    const { execution } = await setup(rt, home, { triggerExtras: { images: [{ id: image.id, mediaType: image.mediaType, name: image.name }], files: [{ id: file.id, name: file.name }] } })
    const second = rt.persistTrigger(rt.triggerFromLine({ coordinatorSessionId: 'lead',
      line: rt.appendLine('lead', { who: 'user', kind: 'text', text: '这是截图和说明' }) }))
    const third = rt.persistTrigger(rt.triggerFromReturn({ coordinatorSessionId: 'lead', text: '还要照顾暗色模式' }))
    rt.state.executions[execution.id].supplements = [second.id, third.id]
    const { text, images, files } = await rt.composeWorkerInput({ executionId: execution.id })
    assert.match(text, /# 用户补充（逐字）\n这是截图和说明\n\n还要照顾暗色模式/)
    assert.match(text, /## 附件（用户提供）\n- 图片 1 张随本消息发送\n- 文件：.+1-说明\.txt/)
    assert.equal(images[0].mediaType, 'image/png')
    assert.ok(files[0].includes('1-说明.txt'))
    assert.match(files[0], /^\.nodo\/workflow-inputs\//)
    const short = await rt.composeSupplementInput({ executionId: execution.id, triggerId: second.id })
    assert.match(short.text, /# 用户补充（逐字）\n这是截图和说明\n\n# 任务范围（不变）\n修复登录页的滚动条bug\n\n# 阶段\n当前阶段继续：按补充调整，不要重做已完成的部分；完成后用 nodo_report 回报。/)
    await assert.rejects(rt.composeSupplementInput({ executionId: execution.id, triggerId: 'missing' }), { code: 'orch/invalid' })
  })
})

test('a return or supplement rework shows the original request, the previous summary and the non-review rework line', async () => {
  await withHost(async ({ runtime, home }) => {
    const rt = await runtime
    const { task, execution } = await setup(rt, home)
    await complete(rt, execution.id, '已完成初版实现')
    const rework = await rt.acceptExecution(task.id, { profileId: 'worker', sessionId: 'ws', type: 'feature', hard: false })
    const reworkTrigger = rt.persistTrigger(rt.triggerFromReturn({ coordinatorSessionId: 'lead', text: '滚动条还是卡顿，请再修。', cardId: 'card1' }))
    Object.assign(rt.state.executions[rework.id], { stage: 'rework', triggerId: reworkTrigger.id, scope: { quote: '修复登录页的滚动条bug' } })
    const { text } = await rt.composeWorkerInput({ executionId: rework.id })
    assert.match(text, /# 原始要求（本任务最初的原话）\n修复登录页的滚动条bug\n（当时的任务范围：修复登录页的滚动条bug）/)
    assert.match(text, /# 阶段\n返工第 1 次：按 # 本轮要求 与 # 用户补充 里的内容处理，不要顺带做其他改动。/)
    assert.match(text, /# 前序结论\n上一执行：已完成初版实现/)
    assert.equal(text.includes('# 前置任务结论'), false, 'no handover section without cross-task material')
  })
})

test('review executions carry the reviewed block, and review-fail rework quotes findings with the flow cap', async () => {
  await withHost(async ({ runtime, home }) => {
    const rt = await runtime
    const { task, execution } = await setup(rt, home)
    rt.state.workspaces.w.worktree = { branch: 'nodo/task-x', baseCommit: '3f2a1c0d4e5f6a7b8c9d' }
    await complete(rt, execution.id, '已完成初版实现')
    Object.assign(rt.state.executions[execution.id], { reportData: { id: 'rep1', outcome: 'done', summary: '修好了',
      changed: [{ path: 'a.js', op: 'update' }], verified: [{ command: 'npm test', result: 'pass' }, { result: 'not-run' }],
      reviewFlags: { crossModule: true, publicInterface: false, dataFormat: false, security: false } },
      evidence: { files: { items: [], total: 0, capture: 'complete', source: 'edit-tools' } } })
    const review = await rt.acceptExecution(task.id, { profileId: 'worker', sessionId: 'ws', type: 'review', hard: false })
    Object.assign(rt.state.executions[review.id], { stage: 'review', triggerId: task.triggerId, scope: { quote: '修复登录页的滚动条bug' }, sourceExecutionId: execution.id })
    const { text } = await rt.composeWorkerInput({ executionId: review.id })
    assert.match(text, /# 被审查的执行\n结论：done —— 修好了\n改动：1 个文件（branch nodo\/task-x @ 3f2a1c0） · 验证：npm test（通过） · （未具名命令）（未运行）\n自报风险：跨模块 是 · 公共接口 否 · 数据格式 否 · 权限与安全 否\n完整报告：nodo_context read sourceId report:rep1    证据：nodo_context read sourceId evidence:(\w|-){36}/)
    assert.match(text, /# 阶段\n审查第 1 轮：只审查、不改代码。回报必须带 verdict；不通过时带 findings 与 category。/)
    await rt.startExecution(review.id)
    await rt.finishExecution(review.id, { final: '审查完成', report: '审查' })
    const rework = await rt.acceptExecution(task.id, { profileId: 'worker', sessionId: 'ws', type: 'feature', hard: false })
    Object.assign(rt.state.executions[rework.id], { stage: 'rework', triggerId: task.triggerId, scope: { quote: '修复登录页的滚动条bug' }, sourceExecutionId: review.id })
    rt.state.executions[review.id].reportData = { verdict: 'fail', findings: [{ category: 'dataFormat', severity: 'high', text: '换行符没有统一' }] }
    const reworked = await rt.composeWorkerInput({ executionId: rework.id })
    assert.match(reworked.text, /# 阶段\n返工第 1 次（上限 3）：只按 # 前序结论 里的问题修改，不要顺带做其他改动。/)
    assert.match(reworked.text, /# 前序结论\n- \[high\] dataFormat：换行符没有统一/)
    assert.equal(reworked.text.includes('# 原始要求'), false, 'a review-fail rework rides the task trigger')
  })
})

test('answer rounds number the questions and note the answers field in the report method', async () => {
  await withHost(async ({ runtime, home }) => {
    const rt = await runtime
    const { task, execution } = await setup(rt, home)
    await complete(rt, execution.id, '已完成初版实现')
    const review = await rt.acceptExecution(task.id, { profileId: 'worker', sessionId: 'ws', type: 'review', hard: false })
    Object.assign(rt.state.executions[review.id], { stage: 'review', triggerId: task.triggerId, scope: { quote: '修复登录页的滚动条bug' }, sourceExecutionId: execution.id })
    await rt.startExecution(review.id)
    await rt.finishExecution(review.id, { final: '补答前审查', report: '审查' })
    const answer = await rt.acceptExecution(task.id, { profileId: 'worker', sessionId: 'ws', type: 'review', hard: false })
    Object.assign(rt.state.executions[answer.id], { stage: 'answer', triggerId: execution.triggerId, scope: { quote: '修复登录页的滚动条bug' },
      sourceExecutionId: review.id, questions: ['改动是否覆盖了滚动容器？', '验证是否真实运行？'] })
    const { text } = await rt.composeWorkerInput({ executionId: answer.id })
    assert.match(text, /# 复核问题\n1\. 改动是否覆盖了滚动容器？\n2\. 验证是否真实运行？/)
    assert.match(text, /# 阶段\n补答第 1 次：按 # 复核问题 逐条回答，不改代码。/)
    assert.match(text, /answers 按编号逐条回答。/)
  })
})

test('handover gathers dependency acceptances and decisions as handles, archives the dependency result and names the continues source', async () => {
  await withHost(async ({ runtime, home }) => {
    const rt = await runtime
    const { task, execution } = await setup(rt, home)
    const dependency = await rt.createTask({ workspaceRef: 'w', teamId: 't', coordinatorSessionId: 'lead', title: '依赖', brief: '依赖任务', source: { kind: 'lead', sessionId: 'lead' } })
    const dependencyExecution = await rt.acceptExecution(dependency.id, { profileId: 'worker', sessionId: 'ws2', type: 'feature', hard: false })
    await complete(rt, dependencyExecution.id, '依赖任务的最终结果文本')
    await rt.completeTask(dependency.id, { reason: '依赖已验收', executionIds: [dependencyExecution.id], basis: ['依赖任务的最终结果文本'] })
    rt.state.tasks[task.id].dependsOn = [dependency.id]
    rt.state.decisions.d1 = { id: 'd1', coordinatorSessionId: 'lead', taskIds: [task.id], status: 'answered', createdAt: 1,
      questions: [{ id: 'q', question: '用哪个滚动方案？', whyUser: '', options: [] }], answer: { values: { q: { text: '用原生滚动' } } } }
    const source = await rt.createTask({ workspaceRef: 'w', teamId: 't', coordinatorSessionId: 'lead', title: '来源', brief: '来源任务', source: { kind: 'lead', sessionId: 'lead' } })
    const sourceExecution = await rt.acceptExecution(source.id, { profileId: 'worker', sessionId: 'ws2', type: 'feature', hard: false })
    await complete(rt, sourceExecution.id, '来源任务的上一执行结果')
    rt.state.tasks[task.id].source = { kind: 'lead', sessionId: 'lead', continuesTaskId: source.id }
    const { text, inputContext } = await rt.composeWorkerInput({ executionId: execution.id })
    assert.match(text, /- 依赖已验收 · 句柄：nodo_context read sourceId task:(\w|-){36}:acceptance/)
    assert.match(text, /- 用哪个滚动方案？ · 句柄：nodo_context read sourceId decision:d1/)
    assert.match(text, /- .+ · 已归档：\.nodo\/workflow-inputs\/.+\.md/)
    assert.match(text, /- 来源任务「来源」上一执行：来源任务的上一执行结果 · 句柄：nodo_context read sourceId execution:(\w|-){36}:result/)
    assert.deepEqual(rt.state.executions[execution.id].contextHandles, ['decision:d1', `task:${dependency.id}:acceptance`, `execution:${sourceExecution.id}:result`])
    await rt.startExecution(execution.id, inputContext)
    await rt.saveStrict()
    const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    assert.equal(saved.executions[execution.id].inputContext.background[0].sourceId, `execution:${dependencyExecution.id}:result`)
    assert.equal(saved.executions[execution.id].inputContext.background[0].bytes, Buffer.byteLength('依赖任务的最终结果文本'))
    assert.equal(saved.executions[execution.id].inputContext.required.length, 2)
  })
})

test('budget pressure drops the history first, then handover summaries keep handles, then prior details clip', async () => {
  await withHost(async ({ runtime, home }) => {
    const rt = await runtime
    const { task, execution } = await setup(rt, home)
    for (let n = 0; n < 6; n++) rt.appendLine('lead', { who: 'user', kind: 'text', text: `历史${n}：${'h'.repeat(2_400)}` })
    for (let n = 0; n < 6; n++) rt.appendLine('lead', { who: 'agent', kind: 'text', text: `回复${n}：${'r'.repeat(2_400)}` })
    await complete(rt, execution.id, '已完成初版实现')
    const dependency = await rt.createTask({ workspaceRef: 'w', teamId: 't', coordinatorSessionId: 'lead', title: '依赖', brief: '依赖任务', source: { kind: 'lead', sessionId: 'lead' } })
    const dependencyExecution = await rt.acceptExecution(dependency.id, { profileId: 'worker', sessionId: 'ws2', type: 'feature', hard: false })
    await complete(rt, dependencyExecution.id, '依赖结果')
    await rt.completeTask(dependency.id, { reason: '依赖已验收', executionIds: [dependencyExecution.id], basis: ['依赖结果'] })
    rt.state.tasks[task.id].dependsOn = [dependency.id]
    const rework = await rt.acceptExecution(task.id, { profileId: 'worker', sessionId: 'ws', type: 'feature', hard: false })
    Object.assign(rt.state.executions[rework.id], { stage: 'rework', triggerId: task.triggerId, scope: { quote: '修复登录页的滚动条bug' }, sourceExecutionId: execution.id })
    rt.state.executions[execution.id].reportData = { verdict: 'fail', findings: [{ category: 'other', severity: 'high', text: 'f'.repeat(120_000) }] }
    const { text } = await rt.composeWorkerInput({ executionId: rework.id })
    assert.ok(text.length <= INPUT_CONTEXT_MAX, `composed input ${text.length} fits the budget`)
    assert.equal(text.includes('# 本会话此前的内容'), false, 'the history window drops first')
    assert.equal(text.includes('依赖已验收 · '), false, 'handover summaries drop before handles')
    assert.match(text, /句柄：nodo_context read sourceId task:(\w|-){36}:acceptance/)
    assert.match(text, /# 前序结论\n- \[high\] other：f{1,4000}… \(前序结论 truncated\)/)
    await assert.rejects(rt.composeWorkerInput({ executionId: 'missing' }), { code: 'orch/not-found' })
    rt.state.triggers[task.triggerId] = undefined
    await assert.rejects(rt.composeWorkerInput({ executionId: rework.id }), { code: 'orch/invalid' })
    rt.state.triggers[task.triggerId] = { id: task.triggerId, coordinatorSessionId: 'lead', origin: { kind: 'user' }, at: 1, text: 'x', images: [], files: [], createdAt: 1 }
    await rt.saveStrict()
    assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).triggers[task.triggerId].text, 'x')
  })
})

test('a degraded worker engine gets the first-line report convention', async () => {
  await withHost(async ({ runtime, home }) => {
    const rt = await runtime
    const { execution } = await setup(rt, home, { engine: 'dsh' })
    const { text } = await rt.composeWorkerInput({ executionId: execution.id })
    assert.match(text, /# 回报方式\n首行必须只写「结论：通过」或「结论：不通过」，其余另起段落。/)
    assert.equal(text.includes('nodo_report 工具'), false)
  })
})

test('review and answer executions get no handover section and no contextHandles', async () => {
  await withHost(async ({ runtime, home }) => {
    const rt = await runtime
    const { task, execution } = await setup(rt, home)
    const dependency = await rt.createTask({ workspaceRef: 'w', teamId: 't', coordinatorSessionId: 'lead', title: '依赖', brief: '依赖任务', source: { kind: 'lead', sessionId: 'lead' } })
    const dependencyExecution = await rt.acceptExecution(dependency.id, { profileId: 'worker', sessionId: 'ws2', type: 'feature', hard: false })
    await complete(rt, dependencyExecution.id, '依赖任务的最终结果文本')
    await rt.completeTask(dependency.id, { reason: '依赖已验收', executionIds: [dependencyExecution.id], basis: ['依赖任务的最终结果文本'] })
    rt.state.tasks[task.id].dependsOn = [dependency.id]
    await complete(rt, execution.id, '已完成初版实现')
    const review = await rt.acceptExecution(task.id, { profileId: 'worker', sessionId: 'ws', type: 'review', hard: false })
    Object.assign(rt.state.executions[review.id], { stage: 'review', triggerId: task.triggerId, scope: { quote: '修复登录页的滚动条bug' }, sourceExecutionId: execution.id })
    const reviewed = await rt.composeWorkerInput({ executionId: review.id })
    assert.equal(reviewed.text.includes('# 前置任务结论'), false)
    assert.deepEqual(reviewed.inputContext.background, [])
    assert.equal(Object.hasOwn(rt.state.executions[review.id], 'contextHandles'), false)
    await rt.startExecution(review.id)
    await rt.finishExecution(review.id, { final: '审查完成', report: '审查' })
    const answer = await rt.acceptExecution(task.id, { profileId: 'worker', sessionId: 'ws', type: 'review', hard: false })
    Object.assign(rt.state.executions[answer.id], { stage: 'answer', triggerId: execution.triggerId, scope: { quote: '修复登录页的滚动条bug' },
      sourceExecutionId: review.id, questions: ['改动是否覆盖了滚动容器？'] })
    const answered = await rt.composeWorkerInput({ executionId: answer.id })
    assert.equal(answered.text.includes('# 前置任务结论'), false)
    assert.equal(Object.hasOwn(rt.state.executions[answer.id], 'contextHandles'), false)
  })
})

test('review-driven and supplement reworks count their rounds separately', async () => {
  await withHost(async ({ runtime, home }) => {
    const rt = await runtime
    const { task, execution } = await setup(rt, home)
    const supplementTrigger = rt.persistTrigger(rt.triggerFromReturn({ coordinatorSessionId: 'lead', text: '滚动条还是卡顿，请再修。' }))
    await complete(rt, execution.id, '已完成初版实现')
    const first = await rt.acceptExecution(task.id, { profileId: 'worker', sessionId: 'ws', type: 'feature', hard: false })
    Object.assign(rt.state.executions[first.id], { stage: 'rework', triggerId: supplementTrigger.id, scope: { quote: '修复登录页的滚动条bug' } })
    assert.match((await rt.composeWorkerInput({ executionId: first.id })).text, /# 阶段\n返工第 1 次：按 # 本轮要求/)
    await rt.startExecution(first.id)
    await rt.finishExecution(first.id, { final: '补充返工完成', report: '补充返工' })
    const review = await rt.acceptExecution(task.id, { profileId: 'worker', sessionId: 'ws', type: 'review', hard: false })
    Object.assign(rt.state.executions[review.id], { stage: 'review', triggerId: task.triggerId, scope: { quote: '修复登录页的滚动条bug' }, sourceExecutionId: first.id })
    await rt.startExecution(review.id)
    await rt.finishExecution(review.id, { final: '审查完成', report: '审查' })
    rt.state.executions[review.id].reportData = { verdict: 'fail', findings: [{ category: 'other', severity: 'high', text: '根因没修' }] }
    const second = await rt.acceptExecution(task.id, { profileId: 'worker', sessionId: 'ws', type: 'feature', hard: false })
    Object.assign(rt.state.executions[second.id], { stage: 'rework', triggerId: task.triggerId, scope: { quote: '修复登录页的滚动条bug' }, sourceExecutionId: review.id })
    const reviewDriven = await rt.composeWorkerInput({ executionId: second.id })
    assert.match(reviewDriven.text, /# 阶段\n返工第 1 次（上限 3）：只按 # 前序结论/)
    assert.match(reviewDriven.text, /- \[high\] other：根因没修/)
    await rt.startExecution(second.id)
    await rt.finishExecution(second.id, { final: '审查返工完成', report: '审查返工' })
    const third = await rt.acceptExecution(task.id, { profileId: 'worker', sessionId: 'ws', type: 'feature', hard: false })
    Object.assign(rt.state.executions[third.id], { stage: 'rework', triggerId: supplementTrigger.id, scope: { quote: '修复登录页的滚动条bug' } })
    assert.match((await rt.composeWorkerInput({ executionId: third.id })).text, /# 阶段\n返工第 2 次：按 # 本轮要求/)
  })
})

test('supplement attachments ride the first input and the short message, and lost bytes or records are never silent', async () => {
  await withHost(async ({ runtime, home }) => {
    const rt = await runtime
    const [missing] = await rt.saveImages([{ mediaType: 'image/png', data: Buffer.from('png').toString('base64'), name: 'p' }])
    rmSync(join(home, 'attachments', `${missing.id}.png`))
    const [file] = await rt.saveFiles([{ name: '清单.txt', bytes: Buffer.from('内容') }])
    const { task, execution } = await setup(rt, home, { triggerExtras: { images: [{ id: missing.id, mediaType: 'image/png', name: 'p' }] } })
    const supplement = rt.persistTrigger(rt.triggerFromLine({ coordinatorSessionId: 'lead',
      line: rt.appendLine('lead', { who: 'user', kind: 'text', text: '补充清单', files: [{ id: file.id, name: file.name }] }) }))
    rt.state.executions[execution.id].supplements = [supplement.id]
    const { text, files } = await rt.composeWorkerInput({ executionId: execution.id })
    assert.match(text, /## 附件（用户提供）\n- 图片 1 张（不可用）\n- 文件：.+1-清单\.txt/)
    assert.equal(files.length, 1)
    const short = await rt.composeSupplementInput({ executionId: execution.id, triggerId: supplement.id })
    assert.match(short.text, /# 阶段\n当前阶段继续：按补充调整，不要重做已完成的部分；完成后用 nodo_report 回报。\n\n## 附件（用户提供）\n- 文件：.+1-清单\.txt/)
    assert.equal(short.files.length, 1)
    await rt.saveStrict()
    rt.state.triggers[supplement.id] = undefined
    await assert.rejects(rt.composeWorkerInput({ executionId: execution.id }), /补充原话不存在或已回收/)
  })
})

test('an omitted dependency result is named in the handover body, not only in inputContext', async () => {
  await withHost(async ({ runtime, home }) => {
    const rt = await runtime
    const { task, execution } = await setup(rt, home)
    const dependency = await rt.createTask({ workspaceRef: 'w', teamId: 't', coordinatorSessionId: 'lead', title: '依赖', brief: '依赖任务', source: { kind: 'lead', sessionId: 'lead' } })
    const dependencyExecution = await rt.acceptExecution(dependency.id, { profileId: 'worker', sessionId: 'ws2', type: 'feature', hard: false })
    await complete(rt, dependencyExecution.id, '')
    await rt.completeTask(dependency.id, { reason: '依赖已验收', executionIds: [dependencyExecution.id], basis: ['验收依据'] })
    rt.state.tasks[task.id].dependsOn = [dependency.id]
    const { text, inputContext } = await rt.composeWorkerInput({ executionId: execution.id })
    assert.match(text, /- 依赖（不可用：missing-final）/)
    assert.deepEqual(inputContext.omitted.map(item => item.reason), ['missing-final'])
  })
})

test('a dangling sourceExecutionId is refused instead of rendering undefined', async () => {
  await withHost(async ({ runtime, home }) => {
    const rt = await runtime
    const { task, execution } = await setup(rt, home)
    await complete(rt, execution.id, '已完成初版实现')
    const review = await rt.acceptExecution(task.id, { profileId: 'worker', sessionId: 'ws', type: 'review', hard: false })
    Object.assign(rt.state.executions[review.id], { stage: 'review', triggerId: task.triggerId, scope: { quote: '修复登录页的滚动条bug' }, sourceExecutionId: 'ghost' })
    await assert.rejects(rt.composeWorkerInput({ executionId: review.id }), /sourceExecutionId 不存在/)
    rt.state.executions[review.id].sourceExecutionId = execution.id
    await rt.startExecution(review.id)
    await rt.finishExecution(review.id, { final: '审查完成', report: '审查' })
    const rework = await rt.acceptExecution(task.id, { profileId: 'worker', sessionId: 'ws', type: 'feature', hard: false })
    Object.assign(rt.state.executions[rework.id], { stage: 'rework', triggerId: task.triggerId, scope: { quote: '修复登录页的滚动条bug' }, sourceExecutionId: 'ghost' })
    await assert.rejects(rt.composeWorkerInput({ executionId: rework.id }), /sourceExecutionId 不存在/)
    void task
  })
})
