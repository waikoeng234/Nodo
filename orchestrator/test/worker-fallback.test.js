import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withFlow } from './helpers/flow.js'

for (const mounted of [true, false, undefined]) {
  for (const stage of ['implement', 'rework', 'review', 'answer']) {
    test(`${stage} reporting uses the actual worker mount (${mounted}) for turns and steered supplements`, () => withFlow(async ({ rt, worker, create, start }) => {
      const ensure = rt.ensureDriver
      rt.ensureDriver = async profile => {
        const driver = await ensure(profile)
        if (profile.profileId === worker.id) {
          const open = driver.openSession
          driver.openSession = async () => {
            await open()
            driver.workerMcpMounted = mounted
          }
          driver.instructionFallback = 'mcp-field-unsupported'
        }
        return driver
      }
      const execution = await create()
      const original = 'Original exact requirement\n完成后用 nodo_report 回报。'
      rt.state.triggers[execution.triggerId].text = original
      rt.state.executions.previous = { ...execution, id: 'previous', stage: 'implement', status: 'done', endedAt: Date.now(),
        reportData: { outcome: 'done', summary: 'Previous' } }
      Object.assign(execution, { stage, sourceExecutionId: 'previous', questions: ['Which check ran?'] })
      await start(execution)
      const driver = rt.driverOf(execution.sessionId)
      const expected = rt.workerReportMethod({ stage, degraded: mounted !== true })
      assert.ok(driver.calls[0].includes(`# 本轮要求（用户原话，逐字，唯一需求来源）\n${original}\n\n`))
      assert.ok(driver.calls[0].endsWith(expected), driver.calls[0])
      const supplement = rt.supplementShort({ supplement: original, scope: 'Original' })
      const sent = await rt.send(worker.id, supplement, execution.sessionId, [], [], {
        origin: { kind: 'supplement', executionId: execution.id },
      })
      assert.equal(sent.mode, 'steered')
      assert.ok(driver.guides[0].startsWith(`# 用户补充（逐字）\n${original}\n\n`))
      assert.ok(driver.guides[0].endsWith(mounted === true ? '完成后用 nodo_report 回报。' : expected.slice('# 回报方式\n'.length)))
    }))
  }
}

test('a driver that mounted without a workerMcpMounted getter still reports in the degraded shape', () => withFlow(async ({ rt, worker, create, start }) => {
  const ensure = rt.ensureDriver
  rt.ensureDriver = async profile => {
    const driver = await ensure(profile)
    if (profile.profileId === worker.id) {
      const open = driver.openSession
      driver.openSession = async () => { await open(); driver.mountedServers = ['nodo_worker'] }
    }
    return driver
  }
  const execution = await create()
  await start(execution)
  const driver = rt.driverOf(execution.sessionId)
  assert.equal(Object.hasOwn(driver, 'workerMcpMounted'), false, 'the fixture models an engine that mounted but exposes no mount state')
  assert.deepEqual(driver.mountedServers, ['nodo_worker'])
  assert.ok(driver.calls[0].endsWith(rt.workerReportMethod({ stage: 'implement', degraded: true })), 'missing mount state must read as unavailable')
  assert.doesNotMatch(driver.calls[0], /nodo_report 工具/)
}))

test('a degraded worker turn rewrites the transcript user line to the text the driver received', () => withFlow(async ({ rt, create, start }) => {
  const execution = await create()
  rt.conversationOf(execution.sessionId).session.instructionMode = 'none'
  await start(execution)
  const driver = rt.driverOf(execution.sessionId)
  const line = rt.transcriptOf(execution.sessionId).at(-1)
  assert.equal(line.who, 'user')
  assert.equal(line.text, driver.calls[0], 'the transcript shows exactly what the engine received')
  assert.match(line.text, /简短总结结果/)
}))

test('a mounted worker turn leaves the transcript user line untouched', () => withFlow(async ({ rt, worker, create, start }) => {
  const ensure = rt.ensureDriver
  rt.ensureDriver = async profile => {
    const driver = await ensure(profile)
    if (profile.profileId === worker.id) {
      const open = driver.openSession
      driver.openSession = async () => { await open(); driver.workerMcpMounted = true }
    }
    return driver
  }
  const execution = await create()
  rt.conversationOf(execution.sessionId).session.instructionMode = 'none'
  await start(execution)
  const driver = rt.driverOf(execution.sessionId)
  const line = rt.transcriptOf(execution.sessionId).at(-1)
  assert.equal(line.who, 'user')
  assert.equal(line.text, driver.calls[0])
  assert.ok(line.text.endsWith(rt.workerReportMethod({ stage: 'implement' })))
  assert.doesNotMatch(line.text, /简短总结结果/)
}))
