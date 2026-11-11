import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { boot, withHost } from './helpers/host.js'

const original = text => ({ who: 'user', kind: 'text', text, at: 1 })

test('user originals are picked by the line origin, and the verbatim text rides with its references', async () => {
  await withHost(async ({ runtime }) => {
    const rt = await runtime
    for (const kind of ['report', 'retry', 'delegation', 'decision', 'supplement', 'answer-request', 'decision-cancel']) {
      assert.equal(rt.isUserTriggerLine({ ...original('x'), origin: { kind } }), false, kind)
    }
    assert.equal(rt.isUserTriggerLine({ ...original('x'), origin: { kind: 'user' } }), true)
    assert.equal(rt.isUserTriggerLine({ ...original('x'), origin: { kind: 'task' } }), true)
    assert.equal(rt.isUserTriggerLine({ ...original('x'), origin: { kind: 'decision-answer' } }), true)
    assert.equal(rt.isUserTriggerLine(original('x')), true)
    assert.equal(rt.isUserTriggerLine({ who: 'agent', kind: 'text', text: 'x', at: 1 }), false)
    assert.equal(rt.isUserTriggerLine({ who: 'user', kind: 'note', text: 'x', at: 1 }), false)
    const line = rt.appendLine('lead', { who: 'user', kind: 'text', text: '修复登录页滚动条',
      images: [{ id: 'img', mediaType: 'image/png', name: 'p' }], files: [{ id: 'file', name: 'a.txt' }] })
    const record = rt.triggerFromLine({ coordinatorSessionId: 'lead', line })
    assert.equal(record.text, '修复登录页滚动条')
    assert.deepEqual(record.images, [{ id: 'img', mediaType: 'image/png' }])
    assert.deepEqual(record.files, [{ id: 'file', name: 'a.txt' }])
    assert.equal(record.handle, `message:lead:${line.at}:${createHash('sha256').update(line.text).digest('hex').slice(0, 8)}`)
    assert.equal(record.origin.kind, 'user')
  })
})

test('a user original spoken in a worker session points its handle at that transcript while the quota stays with the lead', async () => {
  await withHost(async ({ runtime }) => {
    const rt = await runtime
    const line = rt.appendLine('ws', { who: 'user', kind: 'text', text: '补充一句：滚动条在暗色模式才卡' })
    const record = rt.triggerFromLine({ coordinatorSessionId: 'lead', lineSessionId: 'ws', line })
    assert.equal(record.coordinatorSessionId, 'lead')
    assert.equal(record.text, '补充一句：滚动条在暗色模式才卡')
    assert.equal(record.handle, `message:ws:${line.at}:${createHash('sha256').update(line.text).digest('hex').slice(0, 8)}`)
    rt.persistTrigger(record)
    assert.equal(rt.triggerUsageOf('lead'), record.text.length)
    assert.equal(rt.triggerUsageOf('ws'), 0)
  })
})

test('decision answers rebuild the text from answer.values and keep the handle on the echoed line', async () => {
  await withHost(async ({ runtime }) => {
    const rt = await runtime
    rt.state.decisions.d1 = { id: 'd1', coordinatorSessionId: 'lead', status: 'answered', createdAt: 1,
      questions: [{ id: 'q1', question: '选哪个方案？', whyUser: '', options: [{ id: 'a', label: '方案A' }, { id: 'b', label: '方案B' }] },
        { id: 'q2', question: '补充说明？', whyUser: '' }],
      answer: { values: { q1: { optionId: 'b' }, q2: { text: '先做最小版本' } } } }
    const line = rt.appendLine('lead', { id: 'evt1', who: 'user', kind: 'text', text: '决策回答：{"q1":{"optionId":"b"}}',
      origin: { kind: 'decision-answer', decisionId: 'd1' } })
    const record = rt.triggerFromLine({ coordinatorSessionId: 'lead', line })
    assert.equal(record.text, '问题：选哪个方案？\n回答：方案B\n\n问题：补充说明？\n回答：先做最小版本')
    assert.equal(record.decisionId, 'd1')
    assert.equal(record.eventId, 'evt1')
    assert.equal(record.handle, `message:lead:${line.at}:${createHash('sha256').update(line.text).digest('hex').slice(0, 8)}`)
  })
})

test('pending triggers stay in memory, survive a save and read orch/no-trigger after a restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nodo-pending-trigger-'))
  let host = boot(home)
  try {
    let rt = await host.runtime
    const line = rt.appendLine('s', { who: 'user', kind: 'text', text: '给导出加进度条' })
    rt.setPendingTrigger(rt.triggerFromLine({ coordinatorSessionId: 's', line }))
    assert.equal(rt.pendingTriggerOf('s').text, '给导出加进度条')
    assert.equal(rt.requirePendingTrigger('s').text, '给导出加进度条')
    await rt.saveStrict()
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).triggers, {}, 'pending never lands in state')
    await host.dispose()
    host = boot(home)
    rt = await host.runtime
    assert.equal(rt.pendingTriggerOf('s'), undefined)
    assert.throws(() => rt.requirePendingTrigger('s'), { code: 'orch/no-trigger' })
    assert.equal(rt.pendingTriggerOf('other'), undefined)
  } finally { await host.dispose(); rmSync(home, { recursive: true, force: true }) }
})

test('returned acceptance reasons become triggers without a message handle and the quota counts persisted text only', async () => {
  await withHost(async ({ runtime }) => {
    const rt = await runtime
    const record = rt.triggerFromReturn({ coordinatorSessionId: 'lead', text: '滚动条还是卡顿，请再修。', cardId: 'card1' })
    assert.equal(record.origin.kind, 'return')
    assert.equal(record.cardId, 'card1')
    assert.equal(record.handle, undefined)
    const stored = rt.persistTrigger(record)
    assert.equal(stored.text, '滚动条还是卡顿，请再修。')
    const line = rt.appendLine('lead', { who: 'user', kind: 'text', text: '第一条原话' })
    rt.setPendingTrigger(rt.triggerFromLine({ coordinatorSessionId: 'lead', line }))
    assert.equal(rt.triggerUsageOf('lead'), record.text.length, 'pending text stays outside the quota')
    const big = () => rt.persistTrigger(rt.triggerFromReturn({ coordinatorSessionId: 'lead', text: 'x'.repeat(40_000) }))
    assert.equal(big().text.length, 32_000, 'a trigger text caps at the task text limit')
    for (let n = 0; n < 5; n++) rt.persistTrigger(rt.triggerFromReturn({ coordinatorSessionId: 'lead', text: 'x'.repeat(40_000) }))
    assert.equal(rt.triggerUsageOf('lead'), 12 + 6 * 32_000, 'only persisted records count')
    assert.throws(() => rt.persistTrigger(rt.triggerFromReturn({ coordinatorSessionId: 'lead', text: 'x'.repeat(40_000) })), { code: 'orch/trigger-full' })
    const other = rt.persistTrigger(rt.triggerFromReturn({ coordinatorSessionId: 'other', text: '别的会话不受影响' }))
    assert.equal(other.coordinatorSessionId, 'other')
  })
})

test('releasing an accepted or stopped task recycles only its unreferenced trigger records', async () => {
  await withHost(async ({ runtime }) => {
    const rt = await runtime
    const persist = (sessionId, text) => rt.persistTrigger(rt.triggerFromLine({ coordinatorSessionId: sessionId,
      line: rt.appendLine(sessionId, { who: 'user', kind: 'text', text }) }))
    rt.state.workspaces.w = { id: 'w', cwd: 'cwd' }
    rt.state.profiles.leader = { id: 'leader', engine: 'echo', sessions: [{ id: 'lead', workspaceRef: 'w' }] }
    rt.state.profiles.worker = { id: 'worker', engine: 'echo', sessions: [{ id: 's', workspaceRef: 'w' }] }
    rt.state.prefs.teams = [{ id: 't', lead: 'leader', members: ['worker'] }]
    const task = await rt.createTask({ workspaceRef: 'w', teamId: 't', coordinatorSessionId: 'lead', title: 'A', brief: 'A', source: { kind: 'lead', sessionId: 'lead' } })
    const other = await rt.createTask({ workspaceRef: 'w', teamId: 't', coordinatorSessionId: 'lead', title: 'B', brief: 'B', source: { kind: 'lead', sessionId: 'lead' } })
    const shared = persist('lead', '共享原话'), own = persist('lead', '任务A原话'), supplement = persist('lead', '补充原话')
    rt.state.tasks[task.id].triggerId = shared.id
    rt.state.tasks[other.id].triggerId = shared.id
    const execution = await rt.acceptExecution(task.id, { profileId: 'worker', sessionId: 's', type: 'code', hard: false })
    rt.state.executions[execution.id].triggerId = own.id
    rt.state.executions[execution.id].supplements = [supplement.id]
    await rt.saveStrict()
    rt.releaseTaskTriggers(task.id)
    for (const id of [shared.id, own.id, supplement.id]) assert.ok(rt.state.triggers[id], 'a task that has not settled releases nothing')
    rt.state.tasks[task.id].status = 'done'
    rt.releaseTaskTriggers(task.id)
    assert.ok(rt.state.triggers[shared.id], 'another live task still references the shared record')
    assert.ok(rt.state.triggers[supplement.id] === undefined, 'the task-owned supplement record is recycled')
    assert.ok(rt.state.triggers[own.id] === undefined, 'the execution trigger record is recycled')
    rt.state.tasks[other.id].status = 'stopped'
    rt.releaseTaskTriggers(other.id)
    assert.equal(rt.state.triggers[shared.id], undefined)
    assert.deepEqual(rt.state.triggers, {})
  })
})
