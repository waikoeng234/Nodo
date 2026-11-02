import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDriver, engineCatalog } from '../agent-drivers/dist/index.js'
import { boot, until } from './helpers/host.js'

const fixture = async (engine, run) => {
  const cwd = mkdtempSync(join(tmpdir(), `nodo-goal-${engine}-`))
  const bin = join(cwd, engine)
  copyFileSync(new URL(`./fixtures/${engine}-cli.cjs`, import.meta.url), bin)
  chmodSync(bin, 0o755)
  try { await run({ cwd, bin }) } finally { rmSync(cwd, { recursive: true, force: true }) }
}
const requests = (cwd, engine) => readFileSync(join(cwd, `${engine}-requests.jsonl`), 'utf8').trim().split('\n').map(JSON.parse)

test('only Claude and Codex declare native goals', () => {
  assert.deepEqual(engineCatalog().filter(engine => engine.capabilities?.goals).map(engine => engine.id).sort(), ['claude', 'codex'])
  const driver = createDriver('codebuddy')
  try { assert.equal(driver.goals, undefined) } finally { driver.dispose() }
})

test('Codex sets and clears goals by protocol and receives completion outside a turn', async () => {
  await fixture('codex', async ({ cwd, bin }) => {
    const events = []
    const driver = createDriver('codex', { cwd, bin, onEvent: event => events.push(event) })
    try {
      await driver.goals('Complete while idle')
      await until(() => events.some(event => event.type === 'goal' && event.status === 'complete'))
      assert.equal(events.some(event => event.type === 'turn/start'), false)
      assert.equal((await driver.goals()).goal.status, 'complete')
      await driver.goals(null)
      await until(() => events.some(event => event.type === 'goal' && event.cleared))
      const wire = requests(cwd, 'codex').filter(item => item.method.startsWith('thread/goal/'))
      assert.deepEqual(wire.map(item => item.method), ['thread/goal/set', 'thread/goal/get', 'thread/goal/clear'])
      assert.deepEqual(wire[0].params, { threadId: 'fixture-thread', objective: 'Complete while idle', origin: 'user' })
      assert.deepEqual(wire[1].params, { threadId: 'fixture-thread' })
      assert.deepEqual(wire[2].params, { threadId: 'fixture-thread' })
    } finally { driver.dispose() }
  })
})

for (const engine of ['claude', 'codebuddy']) {
  test(`${engine} approval exposes its plan and the next process starts in workspace mode`, async () => {
    await fixture(engine, async ({ cwd, bin }) => {
      const host = boot(join(cwd, 'host'))
      try {
        const workspace = await host.api('workspace-create', { name: 'Project', cwd })
        const role = await host.api('profile-create', { name: 'Planner', engine, permission: 'plan', engineOptions: { bin } })
        const session = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true })
        const rt = await host.runtime
        await host.api('send', { profile: role.id, session: session.id, text: 'EXIT_PLAN' })
        const card = await until(() => rt.approvalsView()[0])
        assert.equal(card.tool, 'ExitPlanMode')
        assert.equal((card.detail.input ?? card.detail.toolCall.rawInput).plan, '# Plan\nRun the checks')
        await host.api('approval-answer', { id: card.id, decision: 'allow' })
        await until(() => !rt.workView()[session.id]?.active)
        assert.equal(rt.conversationOf(session.id).session.permission, 'workspace')
        await host.api('send', { profile: role.id, session: session.id, text: 'Continue' })
        await until(() => !rt.workView()[session.id]?.active)
        const wire = requests(cwd, engine)
        if (engine === 'claude') {
          assert.deepEqual(wire.filter(item => item.spawn).map(item => item.permissionMode), ['plan', 'auto'])
        } else assert.deepEqual(wire.filter(item => item.configId === 'mode').map(item => item.value), ['plan', 'auto'])
        assert.equal(rt.state.profiles[role.id].permission, 'plan')
      } finally { await host.dispose() }
    })
  })
}

test('Claude goal commands are visible turns, keep recovery for the task and clear natively', async () => {
  await fixture('claude', async ({ cwd, bin }) => {
    const host = boot(join(cwd, 'host'))
    try {
      const workspace = await host.api('workspace-create', { name: 'Project', cwd })
      const role = await host.api('profile-create', { name: 'Coder', engine: 'claude', goal: 'Saved role responsibilities', engineOptions: { bin } })
      const session = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true,
        choices: { nativeGoal: 'All tests pass' } })
      const rt = await host.runtime
      rt.conversationOf(session.id).session.restoreContext = true
      await host.api('send', { profile: role.id, session: session.id, text: 'Fix the bug' })
      await until(() => !rt.workView()[session.id]?.active && !rt.workView()[session.id]?.queued)
      const sent = requests(cwd, 'claude').filter(item => item.user).map(item => item.user)
      assert.equal(sent[0], '/goal All tests pass')
      assert.ok(sent[1].includes('Fix the bug'))
      const owned = rt.conversationOf(session.id).session
      assert.equal(owned.name, 'Fix the bug')
      assert.equal(owned.nativeGoal, 'All tests pass')
      assert.equal(owned.goal, 'Saved role responsibilities')
      await host.api('session-update', { profile: role.id, session: session.id, changes: { nativeGoal: '' } })
      await until(() => !rt.workView()[session.id]?.active)
      const transcript = await host.api('transcript', { profile: role.id, session: session.id })
      assert.deepEqual(transcript.filter(item => item.who === 'user').map(item => item.text), ['/goal All tests pass', 'Fix the bug', '/goal clear'])
      assert.ok(requests(cwd, 'claude').some(item => item.user === '/goal clear'))
      assert.equal(rt.conversationOf(session.id).session.nativeGoal, '')
    } finally { await host.dispose() }
  })
})

test('clearing a busy Claude session\'s goal stays pending and the next send retries it', async () => {
  await fixture('claude', async ({ cwd, bin }) => {
    const host = boot(join(cwd, 'host'))
    try {
      const workspace = await host.api('workspace-create', { name: 'Project', cwd })
      const role = await host.api('profile-create', { name: 'Coder', engine: 'claude', engineOptions: { bin } })
      const session = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true })
      const rt = await host.runtime
      await host.api('send', { profile: role.id, session: session.id, text: 'EXIT_PLAN' })
      const card = await until(() => rt.approvalsView()[0])
      // The interrupt came back with the turn still running — the state the
      // engine's 5s interrupt window leaves behind.
      rt.interrupt = async () => true
      await host.api('session-update', { profile: role.id, session: session.id, changes: { nativeGoal: '' } })
      assert.equal(rt.conversationOf(session.id).session.goalPending, true, 'a busy session keeps the clear pending')
      await host.api('approval-answer', { id: card.id, decision: 'allow' })
      await until(() => !rt.workView()[session.id]?.active)
      await host.api('send', { profile: role.id, session: session.id, text: 'Continue' })
      await until(() => !rt.workView()[session.id]?.active && !rt.workView()[session.id]?.queued)
      const sent = requests(cwd, 'claude').filter(item => item.user).map(item => item.user)
      assert.deepEqual(sent, ['EXIT_PLAN', '/goal clear', 'Continue'])
      const owned = rt.conversationOf(session.id).session
      assert.equal(owned.nativeGoal, '')
      assert.equal(owned.goalPending, undefined)
    } finally { await host.dispose() }
  })
})

test('goal choices validate before persistence and preserve the role snapshot', async () => {
  await fixture('codex', async ({ cwd, bin }) => {
    const home = join(cwd, 'host'), host = boot(home)
    try {
      const workspace = await host.api('workspace-create', { name: 'Project', cwd })
      const role = await host.api('profile-create', { name: 'Coder', engine: 'codex', goal: 'Responsibilities', engineOptions: { bin } })
      for (const nativeGoal of [42, null, [], 'x'.repeat(4001), 'a\0b']) {
        await assert.rejects(host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true, choices: { nativeGoal } }), /Invalid conversation goal/)
      }
      const session = await host.api('session-create', { profile: role.id, workspace: workspace.id, lazy: true })
      await assert.rejects(host.api('session-update', { profile: role.id, session: session.id, changes: { nativeGoal: 42 } }), /Invalid conversation goal/)
      await host.api('session-update', { profile: role.id, session: session.id, changes: { nativeGoal: '  Complete while idle  ' } })
      const rt = await host.runtime
      await until(() => rt.conversationOf(session.id).session.nativeGoalStatus === 'complete')
      assert.equal(rt.conversationOf(session.id).session.nativeGoal, undefined)
      assert.equal(rt.conversationOf(session.id).session.goal, 'Responsibilities')
      assert.equal(rt.state.profiles[role.id].goal, 'Responsibilities')
      for (const engine of ['echo', 'codebuddy']) {
        const unsupported = await host.api('profile-create', { name: `Other ${engine}`, engine })
        await assert.rejects(host.api('session-create', { profile: unsupported.id, workspace: workspace.id, lazy: true, choices: { nativeGoal: 'Do work' } }), /no native goal support/)
        const unsupportedSession = await host.api('session-create', { profile: unsupported.id, workspace: workspace.id, lazy: true })
        await assert.rejects(host.api('session-update', { profile: unsupported.id, session: unsupportedSession.id, changes: { nativeGoal: 'Do work' } }), /no native goal support/)
      }
    } finally { await host.dispose() }
  })
})
