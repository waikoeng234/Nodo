// Session statistics: the accumulator folds driver events into per-session
// rounds, steps, wall times and token buckets, the store keeps them, and the
// state answer carries them to the client. The timing cases drive the module
// directly (no engine can be told to take exactly 30 ms); the last test runs a
// real turn through the echo engine to prove the dispatch wiring end to end.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { install } from '../core/src/stats.js'
import { until, withHost } from './helpers/host.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const recorder = () => {
  const rt = { state: { stats: {} }, save: async () => {} }
  install(rt)
  return rt
}

test('one round counts its steps, its decode bursts and its token buckets', async () => {
  const rt = recorder()
  rt.statsRound('s1')
  rt.statsOutput('s1')            // burst one opens
  await sleep(30)
  rt.statsOutput('s1')            // burst one is 30 ms long
  rt.statsTool('s1', 'start')
  await sleep(20)
  rt.statsTool('s1', 'end')       // a 20 ms tool call is one step
  rt.statsOutput('s1')            // burst two opens
  await sleep(10)
  rt.statsEnd('s1', { inputTokens: 100, outputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 5, contextUsed: 1005, contextSize: 8000 })

  const record = rt.statsView().s1
  assert.equal(record.turns, 1)
  assert.equal(record.steps, 1, 'one tool call is one step')
  assert.equal(record.ttftSteps, 1, 'the round saw a first token')
  assert.ok(record.ttftMs < 200, `first token came from the round's start, got ${record.ttftMs}`)
  assert.ok(record.toolMs >= 15 && record.toolMs < 400, `the tool span is measured, got ${record.toolMs}`)
  assert.ok(record.decodeMs >= 25 && record.decodeMs < 400, `only the two output bursts count, got ${record.decodeMs}`)
  assert.ok(record.llmMs >= 0, `model time never goes negative, got ${record.llmMs}`)
  assert.equal(record.inputTokens, 100)
  assert.equal(record.outputTokens, 40)
  assert.equal(record.cacheReadTokens, 900)
  assert.equal(record.cacheWriteTokens, 5)
  assert.equal(record.decodeTokens, 40, 'the output tokens pair with our own decode window')
  assert.equal(record.contextUsed, 1005)
  assert.equal(record.contextSize, 8000)
})

test('an engine that reports its own timing replaces the measured wall times', async () => {
  const rt = recorder()
  rt.statsRound('s1')
  rt.statsOutput('s1')
  await sleep(20)
  rt.statsEnd('s1', { outputTokens: 10, contextUsed: 100, contextSize: 200 })
  const measured = { ...rt.statsView().s1 }
  assert.ok(measured.llmMs >= 15, 'the first round was measured here')

  rt.statsRound('s1')
  rt.statsOutput('s1')
  await sleep(20)
  rt.statsEnd('s1', { outputTokens: 5, contextUsed: 150, contextSize: 200 },
    { ttftMs: 500, ttftSteps: 2, llmMs: 900, toolMs: 100, decodeMs: 400, decodeTokens: 25 })
  const reported = rt.statsView().s1
  assert.equal(reported.turns, 2)
  assert.equal(reported.ttftMs - measured.ttftMs, 500, 'engine timing is used as reported')
  assert.equal(reported.ttftSteps - measured.ttftSteps, 2)
  assert.equal(reported.llmMs - measured.llmMs, 900)
  assert.equal(reported.toolMs - measured.toolMs, 100)
  assert.equal(reported.decodeMs - measured.decodeMs, 400)
  assert.equal(reported.decodeTokens - measured.decodeTokens, 25)
  assert.equal(reported.outputTokens, 15, 'token buckets still sum across rounds')
  assert.equal(reported.contextUsed, 150, 'context occupancy is the newest request, never a sum')
  assert.equal(reported.contextSize, 200)
})

test('an engine that reports only part of its timing keeps the measured rest', async () => {
  const rt = recorder()
  rt.statsRound('s1')
  await sleep(15)
  rt.statsOutput('s1')
  await sleep(20)
  rt.statsOutput('s1')
  rt.statsTool('s1', 'start')
  await sleep(10)
  rt.statsTool('s1', 'end')
  rt.statsEnd('s1', { outputTokens: 8 }, { llmMs: 700 })

  const record = rt.statsView().s1
  assert.equal(record.llmMs, 700, 'the engine figure wins where it reported one')
  assert.ok(record.ttftMs > 0 && record.ttftSteps === 1, 'the measured TTFT survives')
  assert.ok(record.toolMs >= 5, `the measured tool span survives, got ${record.toolMs}`)
  assert.ok(record.decodeMs > 0, `the measured decode window survives, got ${record.decodeMs}`)
  assert.equal(record.outputTokens, 8)
  assert.equal(record.decodeTokens, 8, 'the streamed tokens pair with the measured window')
})

test('output tokens are not invented for an engine-timed decode window', async () => {
  const rt = recorder()
  rt.statsRound('s1')
  rt.statsOutput('s1')
  await sleep(15)
  rt.statsEnd('s1', { outputTokens: 30 }, { decodeMs: 1500, decodeTokens: 12 })
  let record = rt.statsView().s1
  assert.equal(record.decodeMs, 1500)
  assert.equal(record.decodeTokens, 12, 'the engine pair stays untouched')

  rt.statsRound('s1')
  rt.statsOutput('s1')
  await sleep(15)
  rt.statsEnd('s1', { outputTokens: 30 }, { decodeMs: 1500 })
  record = rt.statsView().s1
  assert.equal(record.decodeMs, 1500, 'a window without its token count is left out, not stretched over measured tokens')
  assert.equal(record.decodeTokens, 12, 'no token count is invented for the engine-timed window')
})

test('a ratio pair the engine reported in half is left out instead of mixed with the measured half', async () => {
  const rt = recorder()
  rt.statsRound('s1')
  rt.statsOutput('s1')
  await sleep(15)
  rt.statsEnd('s1', { outputTokens: 9 }, { ttftMs: 420, ttftSteps: 3, decodeMs: 300, decodeTokens: 60 })
  // One half of each pair only: the engine's number must not be averaged over
  // this host's own count, and the host's must not carry the engine's.
  rt.statsRound('s1')
  rt.statsOutput('s1')
  await sleep(10)
  rt.statsEnd('s1', {}, { ttftMs: 80, decodeTokens: 12 })
  const record = rt.statsView().s1
  assert.equal(record.turns, 2)
  assert.equal(record.ttftMs, 420)
  assert.equal(record.ttftSteps, 3, 'the unpaired ttftMs cannot widen the average')
  assert.equal(record.decodeMs, 300)
  assert.equal(record.decodeTokens, 60, 'the unpaired decodeTokens cannot ride a measured window')
})

test('a round without usage still counts, and dropping a session clears its record', async () => {
  const rt = recorder()
  rt.statsRound('s2')
  rt.statsEnd('s2')
  assert.equal(rt.statsView().s2.turns, 1)
  assert.equal(rt.statsView().s2.inputTokens, 0)
  // An event that arrives outside a round is ignored instead of opening one.
  rt.statsOutput('s3')
  rt.statsTool('s3', 'start')
  rt.statsEnd('s3')
  assert.equal(rt.statsView().s3, undefined)
  rt.statsDrop('s2')
  assert.equal(rt.statsView().s2, undefined)
})

test('a finished turn lands one session record and the state answer carries it', async () => {
  await withHost(async ({ api, home }) => {
    const workspace = await api('workspace-create', { name: 'Main', cwd: join(home, 'ws') })
    const profile = await api('profile-create', { name: 'Echo', engine: 'echo', workspace: workspace.id })
    assert.equal(typeof (await api('state')).stats, 'object', 'the live slice always carries the stats table')
    await api('send', { profile: profile.id, text: 'do the thing' })
    const record = await until(async () => {
      const stats = (await api('state', { since: -1 })).stats
      return stats?.[profile.id]?.turns >= 1 ? stats[profile.id] : undefined
    })
    assert.equal(record.steps, 1, 'the echo script runs one tool call')
    assert.ok(record.toolMs > 0, `its tool span is measured through the host, got ${record.toolMs}`)
    assert.equal(record.decodeMs, 0, 'a committed-message engine offers no decode window to measure')
    assert.equal(record.decodeTokens, 0, 'so no speed figure is invented for it')
    assert.equal(record.inputTokens, 0, 'an engine that reports no usage leaves the buckets at zero')
    await until(async () => (await api('state', { since: -1 })).work[profile.id]?.active === false ? true : undefined)
  })
})
