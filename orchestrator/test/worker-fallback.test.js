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
