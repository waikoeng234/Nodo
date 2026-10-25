// Smoke: the whole loop on a mock dsh host with the echo engine — plugin load,
// spawn probe, profile CRUD, dispatch (turn, steer-queue, interrupt), the
// approval card, secret redaction, and a workflow with a decision step. No dsh,
// no coding CLI needed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { registerEchoEngine } from './helpers/echo-driver.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (check, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await check()
    if (value !== undefined && value !== false) return value
    await sleep(80)
  }
  throw new Error('condition not met in time')
}

// A dsh host stand-in: just enough ctx for the modules — effect() collects
// disposers, connection.fetch.register captures the one API route.
const boot = (home) => {
  const disposers = []
  const routes = []
  registerEchoEngine()
  const ctx = {
    logger: { warn: () => {} },
    effect: (factory) => {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    connection: { fetch: { register: route => routes.push(route) } },
  }
  apply(ctx, { home })
  const route = routes.find(entry => entry.path === '/api/nodo')
  const post = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://test/api/nodo', {
      method: 'POST',
      body: JSON.stringify({ endpoint, payload }),
    }))
    return await response.json()
  }
  const api = async (endpoint, payload) => {
    const answer = await post(endpoint, payload)
    if (answer?.ok !== true) throw new Error(`${endpoint}: ${answer?.error?.code} ${answer?.error?.message}`)
    return answer.value
  }
  return { api, post, routes, dispose: () => { for (const disposer of disposers) disposer() }, home }
}

const withPlugin = async (run) => {
  const home = mkdtempSync(join(tmpdir(), 'orch-test-'))
  const plugin = boot(home)
  try {
    await run(plugin)
  } finally {
    plugin.dispose()
    rmSync(home, { recursive: true, force: true })
  }
}

test('Nodo and the legacy API share workspaces and error contracts', async () => {
  await withPlugin(async ({ api, routes, home }) => {
    const legacy = routes.find(entry => entry.path === '/api/orchestrator')
    const post = async (endpoint, payload) => (await legacy.fetch(new Request('http://test/api/orchestrator', {
      method: 'POST', body: JSON.stringify({ endpoint, payload }),
    }))).json()
    const created = await post('workspace-create', { name: 'Existing', cwd: join(home, 'ws') })
    assert.equal(created.ok, true)
    assert.ok((await api('state')).workspaces.some(item => item.id === created.value.id))
    await api('workspace-update', { id: created.value.id, changes: { name: 'Nodo' } })
    assert.equal((await post('state')).value.workspaces.find(item => item.id === created.value.id).name, 'Nodo')
    assert.equal((await post('missing-endpoint')).error.code, 'orch/not-found')
  })
})

test('loads, probes spawn, and lists engines', async () => {
  await withPlugin(async ({ api }) => {
    const probe = await until(async () => (await api('state')).probe?.ok === true ? true : undefined)
    assert.equal(probe, true)
    const engines = await api('engines')
    assert.deepEqual(engines, ['claude', 'codebuddy', 'codex', 'dsh', 'echo', 'opencode', 'pi', 'qoder', 'zcode'])
  })
})

test('profile lifecycle: create, rename to same name, delete', async () => {
  await withPlugin(async ({ api, home }) => {
    const workspace = await api('workspace-create', { name: 'Main', cwd: join(home, 'ws') })
    const profile = await api('profile-create', { name: 'Fixture Coder', role: 'coder', engine: 'echo', workspace: workspace.id })
    assert.equal(profile.name, 'Fixture Coder')
    const renamed = await api('profile-update', { id: profile.id, changes: { name: 'Fixture Coder' } })
    assert.equal(renamed.name, 'Fixture Coder')
    assert.equal(await api('profile-delete', { id: profile.id }), true)
  })
})

test('dispatch: a turn runs, its reply lands in the transcript, and the state goes quiet', async () => {
  await withPlugin(async ({ api, home }) => {
    const workspace = await api('workspace-create', { name: 'Main', cwd: join(home, 'ws') })
    const profile = await api('profile-create', { name: 'Echo', engine: 'echo', workspace: workspace.id })
    const placed = await api('send', { profile: profile.id, text: 'do the thing' })
    assert.equal(placed.mode, 'turn')
    const line = await until(async () =>
      (await api('transcript', { profile: profile.id })).find(entry => entry.who === 'agent' && entry.kind === 'text'))
    assert.match(line.text, /Echo on/)
    await until(async () => (await api('state', { since: -1 })).work[profile.id]?.active === false ? true : undefined)
  })
})

test('approval card: deny stops the turn', async () => {
  await withPlugin(async ({ api, home }) => {
    const workspace = await api('workspace-create', { name: 'Main', cwd: join(home, 'ws') })
    const profile = await api('profile-create', { name: 'Asker', engine: 'echo', workspace: workspace.id })
    await api('send', { profile: profile.id, text: 'go' })
    const card = await until(async () => (await api('state', { since: -1 })).approvals[0])
    assert.equal(card.kind, 'permission')
    await api('approval-answer', { id: card.id, decision: 'deny' })
    await until(async () => (await api('state', { since: -1 })).work[profile.id]?.active === false ? true : undefined)
    const lines = await api('transcript', { profile: profile.id })
    assert.ok(!lines.some(entry => entry.who === 'agent' && entry.kind === 'text' && entry.text.includes('Approved path')), 'denied turn must not reach the post-approval text')
    assert.deepEqual((await api('state', { since: -1 })).approvals, [])
  })
})

test('secrets: values never appear in transcripts', async () => {
  await withPlugin(async ({ api, home }) => {
    await api('secret-set', { name: 'GITHUB_TOKEN', value: 'ghp_supersecret123', purpose: 'test' })
    const workspace = await api('workspace-create', { name: 'Main', cwd: join(home, 'ws') })
    const profile = await api('profile-create', { name: 'Leaky', engine: 'echo', workspace: workspace.id })
    await api('send', { profile: profile.id, text: 'here is ghp_supersecret123 again' })
    const line = await until(async () =>
      (await api('transcript', { profile: profile.id })).find(entry => entry.who === 'user'))
    assert.match(line.text, /\[secret:GITHUB_TOKEN\]/)
    assert.doesNotMatch(line.text, /ghp_supersecret123/)
  })
})

test('workflow: work step → decision card → work step', async () => {
  await withPlugin(async ({ api, home }) => {
    const workspace = await api('workspace-create', { name: 'Main', cwd: join(home, 'ws') })
    const coder = await api('profile-create', { name: 'Writer', engine: 'echo', workspace: workspace.id })
    const reviewer = await api('profile-create', { name: 'Reader', engine: 'echo', workspace: workspace.id })
    const workflow = await api('workflow-create', {
      name: 'pipeline',
      steps: [
        { profile: 'Writer', name: 'draft', task: 'write the draft' },
        { decide: true, name: 'gate', question: 'ship it?' },
        { profile: reviewer.id, name: 'release', task: 'release what was written' },
      ],
    })
    assert.equal(workflow.steps.length, 3)
    await api('workflow-run', { id: workflow.id })
    // Step 1 runs (its echo engine may open a permission card that stays), then
    // the run pauses on the decision card.
    const stepSession = async (profileId, nodeId) => (await api('state')).profiles.find(profile => profile.id === profileId).sessions.find(session => session.source?.workflowId === workflow.id && session.source.nodeId === nodeId)
    const card = await until(async () => (await api('state', { since: -1 })).approvals.find(entry => entry.kind === 'question'))
    assert.equal(card.kind, 'question')
    const draft = await stepSession(coder.id, 's1')
    await until(async () => (await api('state', { since: -1 })).work[draft.id]?.active === false ? true : undefined)
    await api('approval-answer', { id: card.id, decision: 'answer', exit: 'continue' })
    // The decision feeds step 3: its transcript gains the Reader's turn.
    const release = await until(() => stepSession(reviewer.id, 's3'))
    await until(async () => (await api('transcript', { profile: reviewer.id, session: release.id })).some(entry => entry.who === 'user'))
    const readerLines = await api('transcript', { profile: reviewer.id, session: release.id })
    assert.deepEqual(await api('transcript', { profile: reviewer.id }), [])
    const input = readerLines.find(entry => entry.who === 'user')
    const references = input.references
    assert.equal(references[0].source.profileId, coder.id)
    assert.equal(references[0].source.sessionId, draft.id)
    assert.deepEqual(references[1], { source: { kind: 'user', step: 'gate' }, messages: [{ text: 'Decision "gate": 继续' }], decision: { question: 'ship it?', choice: '继续' } })
    assert.equal(input.text, 'release what was written')
  })
})

test('dispatch: a refused steer queues the message and it runs after the turn', async () => {
  await withPlugin(async ({ api, home }) => {
    const workspace = await api('workspace-create', { name: 'Main', cwd: join(home, 'ws') })
    const profile = await api('profile-create', { name: 'Steady', engine: 'echo', workspace: workspace.id, engineOptions: { steerPolicy: 'refuse' } })
    const first = await api('send', { profile: profile.id, text: 'first task' })
    assert.equal(first.mode, 'turn')
    // The turn is up and running; a second message mid-turn queues (engine refuses steer).
    const second = await until(async () => {
      const state = await api('state', { since: -1 })
      return state.work[profile.id]?.active === true ? api('send', { profile: profile.id, text: 'second task' }) : undefined
    })
    assert.equal(second.mode, 'queued')
    await until(async () => {
      const state = await api('state', { since: -1 })
      return state.work[profile.id]?.active === false && state.work[profile.id]?.queued === 0 ? true : undefined
    })
    const lines = await api('transcript', { profile: profile.id })
    const userTexts = lines.filter(entry => entry.who === 'user').map(entry => entry.text)
    assert.deepEqual(userTexts, ['first task', 'second task'])
    const replies = lines.filter(entry => entry.who === 'agent' && entry.kind === 'text' && entry.reply === true)
    assert.equal(replies.length, 2)
    assert.deepEqual(replies.map(entry => [entry.turnId, entry.text]), [
      ['turn-1', 'Approved path taken; finishing.'], ['turn-2', 'Approved path taken; finishing.'],
    ])
  })
})

test('read-only refusal envelopes unknown endpoints and bad input', async () => {
  await withPlugin(async ({ post }) => {
    const unknown = await post('nope', {})
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'orch/not-found')
    const bad = await post('send', { profile: 'ghost', text: 'hi' })
    assert.equal(bad.error.code, 'orch/invalid')
  })
})
