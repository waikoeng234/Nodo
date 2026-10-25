import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { engineCatalog, validateEngineOptions, checkEngine, createDriver, scanEngine, scanEngineCommands, enginePermissionModes, OPTIONAL_METHODS, hasOptionalMethod } from '../agent-drivers/dist/index.js'
import { claudeArgs } from '../agent-drivers/dist/claude/native.js'
import { withHost, boot, until } from './helpers/host.js'

const withFixture = async (run) => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-codex-fixture-'))
  const bin = join(dir, 'codex')
  copyFileSync(new URL('./fixtures/codex-cli.cjs', import.meta.url), bin)
  chmodSync(bin, 0o755)
  try { await run({ bin, cwd: dir }) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('Codex source messages and interleaved results survive the host transcript and a saved-session reload', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const folder = join(cwd, 'plugin')
    let host = boot(folder)
    try {
      const workspace = await host.api('workspace-create', { name: 'Timeline', cwd })
      const role = await host.api('profile-create', { name: 'Timeline', engine: 'codex', workspace: workspace.id, engineOptions: { bin } })
      await host.api('send', { profile: role.id, text: 'TIMELINE' })
      await until(async () => !(await host.api('state')).work[role.id].active)
      const project = lines => lines.filter(line => line.who === 'agent' && ['text', 'thinking', 'tool'].includes(line.kind))
        .map(line => [line.kind, line.messageId ?? line.callId, line.channel ?? line.phase, line.text ?? line.output ?? line.input])
      const before = await host.api('transcript', { profile: role.id })
      const expected = [
        ['text', 'intro', 'commentary', 'First explanation'], ['thinking', 'reason', 'summary', 'Read the file'],
        ['tool', 'read', 'start', 'echo fixture'], ['text', 'middle', 'commentary', 'While the tool runs'],
        ['tool', 'read', 'end', 'fixture result'], ['text', 'answer', 'final_answer', 'Final answer'],
      ]
      assert.deepEqual(project(before), expected)
      assert.equal(before.filter(line => line.reply).length, 1)
      assert.equal((await host.api('state')).profiles[0].sessions[0].lastTurn.report, 'Final answer')
      host.dispose()
      host = boot(folder)
      assert.deepEqual(project(await host.api('transcript', { profile: role.id })), expected)
    } finally { host.dispose() }
  })
})

test('Codex queues early runtime notifications and requests until its own turn receipt confirms ownership', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codex', { bin, cwd, onEvent: event => events.push(event) })
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        events.length = 0
        const id = await driver.sendTurn('EARLY_TIMELINE')
        await until(() => events.some(event => event.type === 'turn/end'))
        const runtime = events.filter(event => event.type !== 'session' && event.type !== 'changes')
        assert.deepEqual(runtime.map(event => event.type), ['turn/start', 'request/opened', 'request/closed', 'delta', 'delta', 'turn/end'])
        assert.equal(runtime[0].turnId, id)
        assert.equal(runtime.at(-1).turnId, id)
        assert.equal(runtime.at(-1).text, 'Early answer')
        assert.equal(runtime.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Early answer')
        assert.ok(!events.some(event => event.text === 'foreign'))
        assert.ok(!events.some(event => event.turnId?.startsWith('starting-')))
      }
    } finally { driver.dispose() }
  })
})

test('Codex installs identity on start and resume while every task stays free of identity text', async () => {
  await withFixture(async ({ bin, cwd }) => {
    let host = boot(join(cwd, 'plugin'))
    try {
      const workspace = await host.api('workspace-create', { name: 'Identity', cwd })
      const instructions = 'Check carefully. '.repeat(110) + 'TAIL_NATIVE_RULE'
      const role = await host.api('profile-create', { name: 'Fixture Reviewer', role: 'review-only', instructions, engine: 'codex', workspace: workspace.id, engineOptions: { bin } })
      await host.api('send', { profile: role.id, text: 'WAIT' })
      await until(() => {
        try { return readFileSync(join(cwd, 'codex-requests.jsonl'), 'utf8').includes('"method":"turn/start"') } catch { return false }
      })
      assert.equal((await host.api('send', { profile: role.id, text: 'change focus' })).mode, 'steered')
      await until(async () => !(await host.api('state')).work[role.id].active)
      await host.api('send', { profile: role.id, text: 'SECOND' })
      await until(async () => !(await host.api('state')).work[role.id].active)
      host.dispose()
      host = boot(join(cwd, 'plugin'))
      await host.api('send', { profile: role.id, text: 'RESTORED' })
      await until(async () => !(await host.api('state')).work[role.id].active)
      const requests = readFileSync(join(cwd, 'codex-requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      const start = requests.find(item => item.method === 'thread/start')
      const resume = requests.find(item => item.method === 'thread/resume')
      assert.match(start.params.developerInstructions, /You are Fixture Reviewer/)
      assert.match(start.params.developerInstructions, /TAIL_NATIVE_RULE/)
      assert.ok(!start.params.developerInstructions.includes('# The task'))
      assert.equal(resume.params.developerInstructions, start.params.developerInstructions)
      assert.equal(requests.find(item => item.method === 'turn/steer').params.input[0].text, 'change focus')
      const turns = requests.filter(item => item.method === 'turn/start')
      assert.deepEqual(turns.slice(0, 2).map(item => item.params.input[0].text), ['WAIT', 'SECOND'])
      assert.match(turns[2].params.input[0].text, /# Saved task context/)
      assert.match(turns[2].params.input[0].text, /# Current task\nRESTORED$/)
      assert.ok(turns.every(item => !item.params.input[0].text.includes('TAIL_NATIVE_RULE')))
      assert.deepEqual((await host.api('transcript', { profile: role.id })).filter(item => item.who === 'user').map(item => item.text), ['WAIT', 'change focus', 'SECOND', 'RESTORED'])
    } finally { host.dispose() }
  })
})

test('Codex downgrades only an explicit unsupported developerInstructions field', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const driver = createDriver('codex', { bin, cwd, instructions: 'Role rules', permission: 'plan', env: { CODEX_FIXTURE_REJECT_INSTRUCTIONS: 'unsupported' } })
    try {
      await driver.openSession()
      assert.equal(driver.instructionMode, 'none')
      const requests = readFileSync(join(cwd, 'codex-requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      assert.equal(requests.length, 2)
      assert.match(requests[0].params.developerInstructions, /^Role rules/)
      assert.match(requests[0].params.developerInstructions, /request_user_input tool/)
      assert.equal(requests[1].params.developerInstructions, undefined)
      assert.equal(requests[1].params.sandbox, 'read-only')
    } finally { driver.dispose() }
  })
  await withFixture(async ({ bin, cwd }) => {
    const driver = createDriver('codex', { bin, cwd, instructions: 'Role rules', env: { CODEX_FIXTURE_REJECT_INSTRUCTIONS: 'auth' } })
    try {
      await assert.rejects(driver.openSession(), /Authentication failed/)
      assert.equal(driver.instructionMode, 'none')
      assert.equal(readFileSync(join(cwd, 'codex-requests.jsonl'), 'utf8').trim().split('\n').length, 1)
    } finally { driver.dispose() }
  })
  await withFixture(async ({ bin, cwd }) => {
    const driver = createDriver('codex', { bin, cwd, instructions: 'Role rules', permission: 'plan', env: { CODEX_FIXTURE_REJECT_INSTRUCTIONS: 'other-field' } })
    try {
      await assert.rejects(driver.openSession(), /unknown field `sandbox`/)
      assert.equal(readFileSync(join(cwd, 'codex-requests.jsonl'), 'utf8').trim().split('\n').length, 1)
    } finally { driver.dispose() }
  })
})

test('Codex plans replace as snapshots while retries, compaction and subagent activity stay structured', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codex', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('PLAN_FLOW')
      await until(() => events.some(event => event.type === 'turn/end'))
      const plans = events.filter(event => event.type === 'plan')
      assert.equal(plans.length, 2)
      assert.equal(plans[0].explanation, 'Fix the bug')
      assert.deepEqual(plans[0].steps, [
        { text: 'read the file', status: 'completed' }, { text: 'edit the code', status: 'in_progress' }, { text: 'run tests', status: 'pending' }])
      assert.deepEqual(plans[1].steps, [
        { text: 'read the file', status: 'completed' }, { text: 'edit the code', status: 'completed' }], 'the second snapshot replaces the first')
      const lifecycle = events.filter(event => event.type === 'lifecycle')
      assert.deepEqual(lifecycle.map(event => [event.kind, event.phase]), [['retry', 'start'], ['compaction', 'end']])
      assert.equal(lifecycle[0].detail, 'rate limited')
      const activity = events.filter(event => event.type === 'activity')
      assert.deepEqual(activity.map(event => [event.entityId, event.phase]), [['sub-1', 'start'], ['sub-1', 'end']])
      assert.equal(activity[0].name, 'subagent')
      assert.equal(activity[0].title, '/agents/reviewer')
      assert.equal(activity[0].detail, 'agentThreadId: thread-child')
      assert.equal(events.find(event => event.type === 'turn/end').reason, 'done')
    } finally { driver.dispose() }
  })
})

test('Codex compacts through the thread protocol', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codex', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.openSession()
      await driver.compact()
      const requests = readFileSync(join(cwd, 'codex-requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      const compact = requests.find(request => request.method === 'thread/compact/start')
      assert.equal(compact.params.threadId, 'fixture-thread')
      assert.equal(events.filter(event => event.type === 'turn/end').length, 1, 'the compaction turn settles even when the engine wraps it in its own turn lifecycle')
      await driver.sendTurn('FIRST')
      await until(() => events.filter(event => event.type === 'turn/end').length >= 2)
    } finally { driver.dispose() }
  })
})

test('Codex settles a compaction announced only by thread/compacted', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codex', { bin, cwd, env: { CODEX_FIXTURE_COMPACT_SIGNAL: '1' }, onEvent: event => events.push(event) })
    try {
      await driver.openSession()
      await driver.compact()
      assert.deepEqual(events.filter(event => event.type === 'lifecycle').map(event => [event.kind, event.phase]), [['compaction', 'end']])
      const end = events.find(event => event.type === 'turn/end')
      assert.equal(end.reason, 'done')
      assert.equal(events.filter(event => event.type === 'turn/start').length, 1)
      await driver.sendTurn('FIRST')
      await until(() => events.filter(event => event.type === 'turn/end').length >= 2)
    } finally { driver.dispose() }
  })
})

test('Codex ignores a turn/started for a turn it did not start', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codex', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('FOREIGN_START')
      await until(() => events.some(event => event.type === 'turn/end'))
      const starts = events.filter(event => event.type === 'turn/start')
      assert.equal(starts.length, 1)
      assert.equal(starts[0].turnId, events.find(event => event.type === 'turn/end').turnId)
    } finally { driver.dispose() }
  })
})

test('Codex marks a turn ended by dispose as unconfirmed', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codex', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('WAIT')
      await until(() => events.some(event => event.type === 'turn/start'))
      driver.dispose()
      const end = events.find(event => event.type === 'turn/end')
      assert.equal(end.reason, 'interrupted')
      assert.equal(end.unconfirmed, true)
    } finally { driver.dispose() }
  })
})

test('Codex surfaces a declared-but-unsupported server request before declining it', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codex', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('UNSUPPORTED_ASK')
      await until(() => events.some(event => event.type === 'turn/end'))
      assert.match(events.find(event => event.type === 'note').text, /item\/permissions\/requestApproval/)
      assert.equal(events.find(event => event.type === 'turn/end').reason, 'done')
    } finally { driver.dispose() }
  })
})

test('Codex reports its runtime identity into the coverage tracker', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const driver = createDriver('codex', { bin, cwd })
    try {
      await driver.openSession()
      assert.deepEqual(driver.coverage.snapshot().identity, { transport: 'app-server proxy', cliVersion: '0.159.2' })
    } finally { driver.dispose() }
  })
})

test('host compaction selects the requested conversation, queues tasks and restores saved context', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const host = boot(join(cwd, 'plugin'))
    try {
      const firstWorkspace = await host.api('workspace-create', { name: 'First', cwd })
      const secondWorkspace = await host.api('workspace-create', { name: 'Second', cwd: join(cwd, 'second') })
      const role = await host.api('profile-create', { name: 'Fixture Compact', engine: 'codex', instructions: 'COMPACT_IDENTITY', engineOptions: { bin } })
      const first = await host.api('session-create', { profile: role.id, workspace: firstWorkspace.id, lazy: true })
      const second = await host.api('session-create', { profile: role.id, workspace: secondWorkspace.id, lazy: true })
      for (const session of [first, second]) {
        await host.api('send', { profile: role.id, session: session.id, text: 'FIRST' })
        await until(async () => !(await host.api('state')).work[session.id].active)
      }
      await host.api('session-update', { profile: role.id, session: second.id, changes: { taskState: { objective: 'Continue the fix', evidence: ['test/login.test.js'] } } })
      const compaction = host.api('session-compact', { profile: role.id, session: second.id })
      assert.equal((await host.api('send', { profile: role.id, session: second.id, text: 'SECOND' })).mode, 'queued')
      await compaction
      assert.equal((await host.api('state')).work[second.id].active, true)
      await until(async () => !(await host.api('state')).work[second.id].active)
      const requestsAt = dir => readFileSync(join(dir, 'codex-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      assert.equal(requestsAt(cwd).some(item => item.method === 'thread/compact/start'), false)
      const requests = requestsAt(join(cwd, 'second'))
      assert.equal(requests.filter(item => item.method === 'thread/compact/start').length, 1)
      assert.equal(requests.some(item => item.method === 'turn/steer'), false)
      const restored = requests.filter(item => item.method === 'turn/start').at(-1).params.input[0].text
      assert.match(restored, /Continue the fix/)
      assert.match(restored, /test\/login.test.js/)
      assert.match(restored, /# Current task\nSECOND$/)
      assert.equal(restored.includes('COMPACT_IDENTITY'), false)
    } finally { host.dispose() }
  })
})

test('catalog describes engine-specific fields; removed and unregistered engines are rejected', () => {
  const catalog = engineCatalog()
  assert.deepEqual(catalog.map(item => item.id), ['claude', 'codebuddy', 'codex', 'dsh', 'echo', 'opencode', 'pi', 'qoder', 'zcode'])
  const codex = catalog.find(item => item.id === 'codex')
  assert.equal(codex.requiresCwd, true)
  assert.deepEqual(codex.fields.map(field => field.name), ['bin', 'model', 'socket'])
  assert.throws(() => validateEngineOptions('claude-headless'), /Unknown engine/)
  assert.throws(() => createDriver('constructor'), /Unknown engine/)
  assert.throws(() => validateEngineOptions('codex', { bin: 'codex --flag' }), /absolute path or a command/)
  assert.throws(() => validateEngineOptions('codex', { args: ['--yolo'] }), /Unsupported/)
})

test('configuration validates combined values atomically and survives a host restart', async () => {
  await withHost(async (host) => {
    const workspace = await host.api('workspace-create', { name: 'Home', cwd: host.home })
    const profile = await host.api('profile-create', { name: 'Echo', engine: 'echo', workspace: workspace.id })
    const locked = await host.post('profile-update', { id: profile.id, changes: { engine: 'codex', workspace: '.' } })
    assert.equal(locked.error.code, 'orch/invalid', 'an engine is fixed once the role exists')
    assert.equal((await host.api('state')).profiles.find(item => item.id === profile.id).name, 'Echo', 'failed validation must not mutate live state')
    assert.equal((await host.post('profile-create', { name: 'Bad', engine: 'codex', workspace: '.' })).ok, false)
    const coder = await host.api('profile-create', { name: 'Fixture Coder', engine: 'codex', workspace: workspace.id })
    const failed = await host.post('profile-update', { id: coder.id, changes: { name: 'Changed', workspace: '.', model: 'test-model' } })
    assert.equal(failed.ok, false)
    const saved = await host.api('profile-update', { id: coder.id, changes: { model: 'test-model', instructions: 'Test instructions', engineOptions: { bin: '/missing/codex' } } })
    assert.equal(saved.model, 'test-model')
    assert.equal(saved.instructions, 'Test instructions')
    host.dispose()
    const reopened = boot(host.home)
    try {
      const value = (await reopened.api('state')).profiles.find(item => item.id === coder.id)
      assert.deepEqual(value.engineOptions, { bin: '/missing/codex' })
      assert.equal(value.workspaceId, workspace.id)
      assert.equal(value.cwd, host.home)
      assert.equal(value.instructions, 'Test instructions')
    } finally { reopened.dispose() }
  })
})

test('editing a busy profile is refused without interrupting its task', async () => {
  await withHost(async ({ api, post, home }) => {
    const workspace = await api('workspace-create', { name: 'Home', cwd: home })
    const profile = await api('profile-create', { name: 'Busy', engine: 'echo', workspace: workspace.id })
    await api('send', { profile: profile.id, text: 'test' })
    const result = await post('profile-update', { id: profile.id, changes: { name: 'Changed' } })
    assert.equal(result.error.code, 'orch/busy')
    assert.equal((await api('state')).profiles.find(item => item.id === profile.id).name, 'Busy')
    assert.equal((await post('profile-delete', { id: profile.id })).error.code, 'orch/busy')
    assert.equal((await api('state')).work[profile.id].active, true)
  })
})

test('engine defaults persist, validate atomically, and leave existing role configurations intact', async () => {
  await withHost(async host => {
    const workspace = await host.api('workspace-create', { name: 'Home', cwd: host.home })
    const existing = await host.api('profile-create', { name: 'Existing', engine: 'codex', workspace: workspace.id, model: 'previous', engineOptions: { bin: '/previous/codex' } })
    const config = { engine: 'codex', model: 'new-model', engineOptions: { bin: '/new/codex' } }
    await host.api('engine-config-set', config)
    const invalid = await host.post('engine-config-set', { ...config, model: 'changed', engineOptions: { bin: 'codex --bad' } })
    assert.equal(invalid.ok, false)
    assert.equal((await host.api('state')).prefs.engineConfigs.codex.model, 'new-model')
    assert.equal((await host.post('engine-config-set', { engine: 'constructor' })).ok, false)
    const created = await host.api('profile-create', { name: 'New', engine: 'codex', workspace: workspace.id })
    assert.equal(created.model, 'new-model')
    assert.deepEqual(created.engineOptions, { bin: '/new/codex' })
    assert.equal((await host.post('profile-create', { name: 'Invalid', engine: 'codex', workspace: workspace.id, engineOptions: null })).ok, false)
    await host.api('profile-update', { id: existing.id, changes: { role: 'reviewer' } })
    const preserved = (await host.api('state')).profiles.find(item => item.id === existing.id)
    assert.equal(preserved.model, 'previous')
    assert.deepEqual(preserved.engineOptions, { bin: '/previous/codex' })
    const other = await host.api('profile-create', { name: 'Other', engine: 'echo', workspace: workspace.id })
    assert.equal((await host.post('profile-update', { id: other.id, changes: { engine: 'codex' } })).error.code, 'orch/invalid',
      'engine defaults reach a role only at creation; the engine is fixed afterwards')
    assert.equal((await host.api('state')).profiles.find(item => item.id === other.id).engine, 'echo')
    host.dispose()
    const reopened = boot(host.home)
    try {
      assert.deepEqual((await reopened.api('state')).prefs.engineConfigs.codex, { model: 'new-model', engineOptions: { bin: '/new/codex' } })
    } finally { reopened.dispose() }
  })
})

test('the command scan lists claude skills, namespaces plugin skills, and reports engines without a source', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-claude-home-'))
  const project = mkdtempSync(join(tmpdir(), 'orch-claude-project-'))
  try {
    mkdirSync(join(home, 'skills', 'deploy'), { recursive: true })
    writeFileSync(join(home, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Ship the build\n---\nbody')
    mkdirSync(join(home, 'commands'), { recursive: true })
    writeFileSync(join(home, 'commands', 'review.md'), '---\ndescription: Review the diff\n---\nbody')
    mkdirSync(join(home, 'plugins', 'marketplaces', 'official', 'plugins', 'documents', 'skills', 'docx'), { recursive: true })
    writeFileSync(join(home, 'plugins', 'marketplaces', 'official', 'plugins', 'documents', 'skills', 'docx', 'SKILL.md'), '---\nname: docx\n---\nbody')
    mkdirSync(join(project, '.claude', 'skills', 'local-skill'), { recursive: true })
    writeFileSync(join(project, '.claude', 'skills', 'local-skill', 'SKILL.md'), 'no frontmatter at all')
    symlinkSync(join(home, 'commands', 'review.md'), join(home, 'commands', 'review-link.md'))
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = home
    try {
      const scan = await scanEngineCommands('claude', { cwd: project })
      assert.equal(scan.engine, 'claude')
      assert.equal(scan.source, 'Claude skills and commands')
      assert.deepEqual([...scan.commands.map(command => command.id)].sort(), ['deploy', 'documents:docx', 'local-skill', 'review'], 'a symlinked copy of a listed skill stays hidden')
      const deploy = scan.commands.find(command => command.id === 'deploy')
      assert.equal(deploy.description, 'Ship the build')
      assert.equal(deploy.scope, 'global')
      assert.equal(deploy.origin, 'global')
      assert.ok(deploy.path.endsWith(join('skills', 'deploy', 'SKILL.md')))
      assert.equal(scan.commands.find(command => command.id === 'review').description, 'Review the diff')
      assert.equal(scan.commands.find(command => command.id === 'local-skill').scope, 'project')
      const docx = scan.commands.find(command => command.id === 'documents:docx')
      assert.equal(docx.description, undefined)
      assert.equal(docx.scope, 'plugin')
      assert.equal(docx.origin, 'documents')
      assert.equal(engineCatalog().find(item => item.id === 'claude').capabilities.commands, true)
      assert.deepEqual(await scanEngineCommands('echo', {}), { engine: 'echo', source: 'unsupported', commands: [] })
      await assert.rejects(scanEngineCommands('constructor', {}), /Unknown engine/)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
    }
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }) }
})

test('zcode, codex and opencode scan their global skill and prompt locations', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-global-home-'))
  try {
    mkdirSync(join(home, '.agents', 'skills', 'coord'), { recursive: true })
    writeFileSync(join(home, '.agents', 'skills', 'coord', 'SKILL.md'), '---\nname: coord\ndescription: Orchestrate work\n---\nbody')
    mkdirSync(join(home, '.codex', 'skills', 'pack'), { recursive: true })
    writeFileSync(join(home, '.codex', 'skills', 'pack', 'SKILL.md'), '---\nname: pack\ndescription: Linked pack\n---\nbody')
    symlinkSync('../../.codex/skills/pack', join(home, '.agents', 'skills', 'pack'))
    mkdirSync(join(home, '.zcode', 'cli', 'plugins', 'cache', 'officials', 'demo', '0.9.0', 'skills', 'alpha'), { recursive: true })
    writeFileSync(join(home, '.zcode', 'cli', 'plugins', 'cache', 'officials', 'demo', '0.9.0', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nold')
    mkdirSync(join(home, '.zcode', 'cli', 'plugins', 'cache', 'officials', 'demo', '0.10.0', 'skills', 'beta'), { recursive: true })
    writeFileSync(join(home, '.zcode', 'cli', 'plugins', 'cache', 'officials', 'demo', '0.10.0', 'skills', 'beta', 'SKILL.md'), '---\nname: beta\n---\nnew')
    mkdirSync(join(home, '.codex', 'prompts'), { recursive: true })
    writeFileSync(join(home, '.codex', 'prompts', 'review.md'), '---\ndescription: Review the diff\n---\nbody')
    mkdirSync(join(home, '.codex', 'plugins', 'cache', 'officials', 'demo', '0.9.0', 'skills', 'alpha'), { recursive: true })
    writeFileSync(join(home, '.codex', 'plugins', 'cache', 'officials', 'demo', '0.9.0', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nold')
    mkdirSync(join(home, '.codex', 'plugins', 'cache', 'officials', 'demo', '1.0.0', 'skills', 'remotion-create'), { recursive: true })
    writeFileSync(join(home, '.codex', 'plugins', 'cache', 'officials', 'demo', '1.0.0', 'skills', 'remotion-create', 'SKILL.md'), '---\nname: remotion-create\ndescription: Create a new Remotion video\n---\nbody')
    mkdirSync(join(home, 'opencode', 'command'), { recursive: true })
    writeFileSync(join(home, 'opencode', 'command', 'ship.md'), '---\ndescription: Ship it\n---\nbody')
    const previous = [process.env.HOME, process.env.CODEX_HOME, process.env.XDG_CONFIG_HOME]
    process.env.HOME = home
    process.env.CODEX_HOME = join(home, '.codex')
    process.env.XDG_CONFIG_HOME = home
    try {
      const zcode = await scanEngineCommands('zcode', {})
      assert.equal(zcode.source, 'ZCode skills')
      assert.deepEqual([...zcode.commands.map(command => command.id)].sort(), ['coord', 'demo:beta', 'pack'], 'only the newest plugin version is listed')
      assert.equal(zcode.commands.find(command => command.id === 'coord').description, 'Orchestrate work')
      assert.equal(zcode.commands.find(command => command.id === 'coord').scope, 'global')
      assert.equal(zcode.commands.find(command => command.id === 'pack').description, 'Linked pack', 'a symlinked skill dir lists through its target')
      assert.equal(zcode.commands.find(command => command.id === 'demo:beta').scope, 'plugin')
      assert.equal(zcode.commands.find(command => command.id === 'demo:beta').origin, 'demo')
      const codex = await scanEngineCommands('codex', {})
      assert.equal(codex.source, 'Codex prompts and plugin skills')
      assert.deepEqual([...codex.commands.map(command => command.id)], ['review', 'remotion-create'], 'plugin skills carry plain names, newest version only')
      assert.equal(codex.commands.find(command => command.id === 'review').description, 'Review the diff')
      assert.equal(codex.commands.find(command => command.id === 'review').scope, 'global')
      assert.equal(codex.commands.find(command => command.id === 'remotion-create').description, 'Create a new Remotion video')
      assert.equal(codex.commands.find(command => command.id === 'remotion-create').scope, 'plugin')
      const opencode = await scanEngineCommands('opencode', {})
      assert.equal(opencode.source, 'OpenCode commands and skills')
      assert.deepEqual([...opencode.commands.map(command => command.id)].sort(), ['coord', 'pack', 'ship'])
      assert.equal(opencode.commands.find(command => command.id === 'ship').scope, 'global')
      assert.equal(opencode.commands.find(command => command.id === 'coord').scope, 'global', 'the agents compatibility tree lists its skills')
      const project = mkdtempSync(join(tmpdir(), 'orch-global-project-'))
      try {
        mkdirSync(join(project, '.opencode', 'command'), { recursive: true })
        writeFileSync(join(project, '.opencode', 'command', 'ship.md'), '---\ndescription: Local ship\n---\nbody')
        const local = await scanEngineCommands('opencode', { cwd: project })
        assert.deepEqual([...local.commands.map(command => command.id)].sort(), ['coord', 'pack', 'ship'])
        assert.equal(local.commands.find(command => command.id === 'ship').description, 'Local ship', 'the project command wins the name collision')
        assert.equal(local.commands.find(command => command.id === 'ship').scope, 'project')
      } finally { rmSync(project, { recursive: true, force: true }) }
      assert.equal(engineCatalog().find(item => item.id === 'zcode').capabilities.commands, true)
    } finally {
      for (const [index, key] of ['HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME'].entries()) {
        if (previous[index] === undefined) delete process.env[key]
        else process.env[key] = previous[index]
      }
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('dsh scans the skill roots its own skill filesystem loads, in rank order', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-dsh-skills-home-'))
  const project = mkdtempSync(join(tmpdir(), 'orch-dsh-skills-project-'))
  const previous = [process.env.HOME, process.env.DSH_HOME, process.env.DSH_AGENTS_HOME]
  process.env.HOME = home
  delete process.env.DSH_HOME
  delete process.env.DSH_AGENTS_HOME
  try {
    const skill = (dir, file, front) => {
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      writeFileSync(join(dir, file), `---\n${front}\n---\nbody`)
    }
    skill(join(project, '.dsh', 'skills'), join('alpha', 'SKILL.md'), 'name: alpha\ndescription: Project alpha')
    skill(join(project, '.agents', 'skills'), join('crew', 'SKILL.md'), 'name: crew\ndescription: Project crew')
    skill(join(home, '.dsh', 'skills'), join('alpha', 'SKILL.md'), 'name: alpha\ndescription: Home alpha')
    skill(join(home, '.dsh', 'skills'), join('.system', 'internal', 'SKILL.md'), 'name: internal\ndescription: Hidden bundle')
    skill(join(home, '.dsh', 'skills'), 'flat.md', 'name: flat\ndescription: Flat file')
    skill(join(home, '.dsh', 'skills'), join('quiet', 'SKILL.md'), 'name: quiet\ndescription: Hidden\nuser-invocable: false')
    skill(join(home, '.dsh', 'skills'), join('legacy', 'SKILL.md'), 'name: legacy\ndescription: Legacy key\nuserInvocable: true')
    skill(join(home, '.dsh', 'skills'), join('unnamed', 'SKILL.md'), 'description: Missing name')
    skill(join(home, '.dsh', 'skills'), join('Weird', 'SKILL.md'), 'name: Weird\ndescription: Not kebab')
    skill(join(home, '.dsh', 'skills'), 'notes.txt', 'name: notes\ndescription: Not markdown')
    skill(join(home, '.agents', 'skills'), join('shared', 'SKILL.md'), 'name: shared\ndescription: Agents home')
    const scan = await scanEngineCommands('dsh', { cwd: project })
    assert.equal(scan.source, 'DSH skills')
    assert.deepEqual([...scan.commands.map(command => command.id)], ['alpha', 'crew', 'flat', 'shared'],
      'project roots come first, a project namesake blocks the user one, non-skills stay out')
    const alpha = scan.commands.find(command => command.id === 'alpha')
    assert.equal(alpha.scope, 'project')
    assert.equal(alpha.description, 'Project alpha')
    assert.equal(alpha.path, realpathSync(join(project, '.dsh', 'skills', 'alpha', 'SKILL.md')))
    assert.equal(scan.commands.find(command => command.id === 'flat').scope, 'global')
    assert.equal(engineCatalog().find(item => item.id === 'dsh').capabilities.commands, true)
    const pinned = mkdtempSync(join(tmpdir(), 'orch-dsh-skills-pin-'))
    try {
      skill(join(pinned, 'skills'), join('pinned', 'SKILL.md'), 'name: pinned\ndescription: Pinned home')
      const local = await scanEngineCommands('dsh', { cwd: project, engineOptions: { home: pinned } })
      assert.deepEqual([...local.commands.map(command => command.id)], ['alpha', 'crew', 'pinned', 'shared'], 'engineOptions.home replaces the dsh home root only')
    } finally { rmSync(pinned, { recursive: true, force: true }) }
  } finally {
    for (const [index, key] of ['HOME', 'DSH_HOME', 'DSH_AGENTS_HOME'].entries()) {
      if (previous[index] === undefined) delete process.env[key]
      else process.env[key] = previous[index]
    }
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('the autonomy tier maps onto each engine sandbox channel and validates on the role card', async () => {
  const modeOf = args => { const at = args.indexOf('--permission-mode'); return at === -1 ? undefined : args[at + 1] }
  assert.equal(modeOf(claudeArgs({ permission: 'plan' })), 'plan')
  assert.equal(modeOf(claudeArgs({ permission: 'full' })), 'bypassPermissions')
  assert.equal(modeOf(claudeArgs({ permission: 'workspace' })), 'auto', 'the engine classifier tier: ordinary actions run, dangerous ones ask')
  assert.deepEqual(enginePermissionModes('claude'), ['plan', 'workspace', 'full'])
  assert.deepEqual(enginePermissionModes('opencode'), ['plan', 'workspace'])
  assert.deepEqual(enginePermissionModes('dsh'), [])
  assert.throws(() => enginePermissionModes('constructor'), /Unknown engine/)
  await withFixture(async ({ bin, cwd }) => {
    for (const permission of ['plan', 'workspace', 'full']) {
      const driver = createDriver('codex', { bin, cwd, permission })
      try { await driver.openSession() } finally { driver.dispose() }
    }
    const starts = readFileSync(join(cwd, 'codex-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      .filter(item => item.method === 'thread/start')
    assert.deepEqual(starts.map(item => [item.params.sandbox, item.params.approvalPolicy]),
      [['read-only', undefined], ['workspace-write', undefined], ['danger-full-access', 'never']])
  })
  await withHost(async ({ api, post, home }) => {
    const workspace = await api('workspace-create', { name: 'Home', cwd: home })
    const full = await api('profile-create', { name: 'Auto', engine: 'echo', workspace: workspace.id, permission: 'full' })
    assert.equal(full.permission, 'full')
    assert.equal((await post('profile-create', { name: 'Bad', engine: 'dsh', workspace: workspace.id, permission: 'full' })).error.code, 'orch/invalid')
    assert.equal((await post('profile-update', { id: full.id, changes: { engine: 'dsh' } })).error.code, 'orch/invalid',
      'a tier the new engine lacks is unreachable: the engine is fixed once the role exists')
    const kept = await api('profile-update', { id: full.id, changes: { permission: 'plan' } })
    assert.equal(kept.permission, 'plan')
    const tiered = await api('profile-update', { id: kept.id, changes: { permission: 'full' } })
    assert.equal(tiered.permission, 'full')
    assert.deepEqual(tiered.sessions.map(item => item.id), kept.sessions.map(item => item.id),
      'a tier change keeps the conversation instead of opening a new session')
  })
})

test('session activity timestamps and role deletion cover every conversation', async () => {
  await withHost(async ({ api, home }) => {
    const workspace = await api('workspace-create', { name: 'Home', cwd: home })
    const profile = await api('profile-create', { name: 'Echo', engine: 'echo', workspace: workspace.id })
    assert.deepEqual(profile.sessions, [], 'a fresh role shows no session until one is created')
    const session = await api('session-create', { profile: profile.id })
    await api('send', { profile: profile.id, session: session.id, text: 'timestamp' })
    await until(async () => !(await api('state')).work[session.id].active)
    const lines = await api('transcript', { profile: profile.id, session: session.id })
    const value = (await api('state')).profiles.find(item => item.id === profile.id)
    assert.equal(value.sessions.find(item => item.id === session.id).updatedAt, lines.at(-1).at)
    await api('profile-delete', { id: profile.id })
    assert.deepEqual((await api('state')).profiles, [])
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).transcripts, {})
  })
})

test('environment check uses version, handshake and existing auth without exposing account details', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const result = await checkEngine({ engine: 'codex', cwd, engineOptions: { bin } })
    assert.equal(result.ok, true)
    assert.equal(result.executable, bin)
    assert.equal(result.version, 'codex-cli fixture')
    assert.ok(!JSON.stringify(result).includes('private@example'))
    assert.equal((await checkEngine({ engine: 'codex', cwd, engineOptions: { bin: join(cwd, 'missing') } })).ok, false)
  })
})

test('scanning an engine lists its models with their thinking levels, and falls back to the local config', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const catalog = await scanEngine('codex', { engineOptions: { bin } })
    assert.equal(catalog.source, 'Codex app-server model/list')
    assert.equal(catalog.defaultModel, 'fixture-model')
    assert.deepEqual(catalog.models.map(model => model.id), ['fixture-model', 'other-model'], 'hidden models stay out')
    assert.deepEqual(catalog.models[0].thinking.map(level => level.id), ['low', 'medium', 'high'])
    assert.equal(catalog.models[0].defaultThinking, 'medium')
    assert.deepEqual((await scanEngine('echo', {})).models, [], 'an engine without discovery reports an empty list')
    assert.equal((await scanEngine('echo', {})).source, 'unsupported')
    // A CLI that cannot be reached: the CLI's own configuration answers instead.
    const home = mkdtempSync(join(tmpdir(), 'orch-codex-home-'))
    writeFileSync(join(home, 'config.toml'), [
      'model = "gpt-local"', 'model_reasoning_effort = "high"', '',
      '[profiles.fast]', 'model = "gpt-fast"', 'model_reasoning_effort = "low"', '',
      '[mcp_servers.fixture]', 'command = "true"', '',
    ].join('\n'))
    const previous = process.env.CODEX_HOME
    process.env.CODEX_HOME = home
    try {
      const fallback = await scanEngine('codex', { engineOptions: { bin: join(cwd, 'missing-codex') } })
      assert.equal(fallback.source, 'Codex config.toml')
      assert.equal(fallback.defaultModel, 'gpt-local')
      assert.deepEqual(fallback.models.map(model => model.id), ['gpt-local', 'gpt-fast'])
      assert.equal(fallback.models[0].defaultThinking, 'high', 'the configured effort stays as the default')
      assert.equal(fallback.models[0].thinking, undefined, 'the config fallback does not invent effort levels')
      assert.equal(fallback.models[1].label, 'fast')
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  })
})

test('a thinking level reaches the engine turn and the scanned default becomes a role default', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codex', { bin, cwd, thinking: 'high', onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('EFFORT')
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Effort high')
    } finally { driver.dispose() }
  })
  await withFixture(async ({ bin, cwd }) => withHost(async ({ api, post, home }) => {
    await api('engine-config-set', { engine: 'codex', engineOptions: { bin } })
    const catalog = await api('engine-scan', { engine: 'codex' })
    assert.equal(catalog.defaultModel, 'fixture-model')
    assert.equal(typeof catalog.at, 'number')
    const listed = (await api('engine-catalog')).find(item => item.id === 'codex')
    assert.deepEqual(listed.catalog.models.map(model => model.id), ['fixture-model', 'other-model'], 'the cached catalog rides with the engine list')
    assert.equal((await post('engine-scan', { engine: 'constructor' })).ok, false)
    const saved = await api('engine-config-set', { engine: 'codex', model: 'other-model', thinking: 'high', engineOptions: { bin } })
    assert.equal(saved.thinking, 'high')
    assert.equal((await post('engine-config-set', { engine: 'codex', model: 'm', thinking: 'not a level', engineOptions: { bin } })).ok, false)
    const profile = await api('profile-create', { name: 'Fixture Coder', engine: 'codex', workspace: (await api('workspace-create', { name: 'Fixture', cwd: home })).id })
    assert.equal(profile.model, 'other-model')
    assert.equal(profile.thinking, 'high')
    assert.equal((await api('state')).prefs.engineConfigs.codex.thinking, 'high')
    assert.equal((await post('profile-update', { id: profile.id, changes: { engine: 'echo' } })).error.code, 'orch/invalid',
      'the engine is fixed once the role exists; the scanned defaults stay')
    const kept = (await api('state')).profiles.find(item => item.id === profile.id)
    assert.equal(kept.model, 'other-model')
    assert.equal(kept.thinking, 'high')
  }))
})

for (const format of [undefined, 3]) test(`a catalog cached with format ${format} is scanned again`, async () => {
  await withFixture(async ({ bin, cwd }) => {
    const home = mkdtempSync(join(tmpdir(), 'orch-catalog-format-'))
    writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 2,
      prefs: { engineConfigs: { codex: { engineOptions: { bin } } } },
      engineCatalogs: { codex: { format, source: 'older build', at: 1, models: [{ id: 'legacy-model', thinking: [{ id: 'default' }] }] } } }))
    let host = boot(home)
    try {
      assert.equal((await host.api('engine-catalog')).find(item => item.id === 'codex').catalog, null, 'the older cached list is not served')
      assert.equal((await host.api('engine-detect')).find(item => item.id === 'codex').catalog, null)
      const scanned = await host.api('engine-scan', { engine: 'codex' })
      assert.ok(scanned.format > 3, 'a fresh scan invalidates catalogs with fabricated thinking levels')
      const listed = (await host.api('engine-catalog')).find(item => item.id === 'codex')
      assert.deepEqual(listed.catalog.models.map(model => model.id), ['fixture-model', 'other-model'], 'the fresh scan is served')
      assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).engineCatalogs.codex.format, scanned.format, 'the format is what the file keeps')
      host.dispose()
      host = boot(home)
      assert.deepEqual((await host.api('engine-catalog')).find(item => item.id === 'codex').catalog, scanned, 'a current catalog survives restart')
    } finally { host.dispose(); rmSync(home, { recursive: true, force: true }) }
  })
})

test('legacy default thinking choices follow the engine after loading and saving', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const home = join(cwd, 'plugin')
    mkdirSync(home)
    const path = join(home, 'state.json')
    const profile = { id: 'role', name: 'Coder', engine: 'codex', workspaceId: 'workspace', model: 'fixture-model', thinking: 'default', engineOptions: { bin },
      activeSessionId: 'default', sessions: [
        { id: 'default', name: 'Default', engine: 'codex', workspaceRef: 'workspace', model: 'fixture-model', thinking: 'default', engineOptions: { bin }, briefSent: true },
        { id: 'high', name: 'High', engine: 'codex', workspaceRef: 'workspace', thinking: 'high', engineOptions: { bin }, driverSessionId: 'kept-thread' },
      ] }
    writeFileSync(path, JSON.stringify({ version: 2, profiles: { role: profile,
      implicit: { id: 'implicit', name: 'Implicit', engine: 'echo', thinking: 'default', engineOptions: {} } },
      workspaces: { workspace: { id: 'workspace', name: 'Workspace', cwd } },
      prefs: { engineConfigs: { codex: { thinking: 'default', engineOptions: { bin } }, echo: { thinking: 'high', engineOptions: {} } } },
      transcripts: { default: [{ who: 'user', text: 'Previous task', at: 1 }] } }))
    let host = boot(home)
    try {
      const state = await host.api('state')
      const restored = state.profiles.find(item => item.id === 'role')
      assert.equal(restored.thinking, undefined)
      assert.equal(restored.sessions.find(item => item.id === 'default').thinking, undefined)
      assert.equal(restored.sessions.find(item => item.id === 'high').thinking, 'high')
      assert.equal(restored.sessions.find(item => item.id === 'high').driverSessionId, 'kept-thread')
      assert.equal(state.profiles.find(item => item.id === 'implicit').thinking, undefined)
      assert.equal(state.prefs.engineConfigs.codex.thinking, undefined)
      assert.equal(state.prefs.engineConfigs.echo.thinking, 'high')
      const created = await host.api('profile-create', { name: 'New coder', engine: 'codex' })
      assert.equal(created.thinking, undefined, 'new roles do not inherit the legacy marker')
      const draft = await host.api('session-create', { profile: profile.id, workspace: 'workspace', lazy: true })
      assert.equal(draft.thinking, undefined, 'new sessions do not inherit the legacy marker')
      await host.api('send', { profile: profile.id, session: 'default', text: 'EFFORT' })
      await until(async () => !(await host.api('state')).work.default.active)
      const transcript = await host.api('transcript', { profile: profile.id, session: 'default' })
      assert.equal(transcript[0].text, 'Previous task')
      assert.ok(transcript.some(line => line.text === 'Effort none'), 'the driver receives no explicit effort')
      const saved = JSON.parse(readFileSync(path, 'utf8'))
      assert.equal(saved.prefs.engineConfigs.codex.thinking, undefined)
      assert.equal(saved.profiles.role.thinking, undefined)
      assert.equal(saved.profiles.role.sessions.find(item => item.id === 'default').thinking, undefined)
      assert.equal(saved.profiles.implicit.thinking, undefined)
      host.dispose()
      host = boot(home)
      assert.equal((await host.api('state')).profiles.find(item => item.id === 'role').sessions.find(item => item.id === 'high').thinking, 'high')
    } finally { host.dispose() }
  })
})

test('legacy default thinking inputs clear explicit engine, role and session choices', async () => {
  await withHost(async ({ api, home }) => {
    await api('engine-config-set', { engine: 'echo', thinking: 'high' })
    const profile = await api('profile-create', { name: 'Coder', engine: 'echo', thinking: 'default' })
    assert.equal(profile.thinking, undefined)
    await api('profile-update', { id: profile.id, changes: { thinking: 'high' } })
    const workspace = await api('workspace-create', { name: 'Workspace', cwd: home })
    const session = await api('session-create', { profile: profile.id, workspace: workspace.id, lazy: true, choices: { thinking: 'default' } })
    assert.equal(session.thinking, undefined)
    await api('session-update', { profile: profile.id, session: session.id, changes: { thinking: 'high' } })
    assert.equal((await api('session-update', { profile: profile.id, session: session.id, changes: { thinking: 'default' } })).thinking, undefined)
    assert.equal((await api('profile-update', { id: profile.id, changes: { thinking: 'default' } })).thinking, undefined)
    assert.equal((await api('engine-config-set', { engine: 'echo', thinking: 'default' })).thinking, undefined)
  })
})

test('the engine catalog lists only engines usable on this machine', async () => {
  await withHost(async ({ api }) => {
    assert.equal((await api('engine-catalog')).some(item => item.id === 'echo'), false, 'an engine with nothing to detect stays hidden')
    await api('engine-config-set', { engine: 'codex', engineOptions: { bin: '/opt/fake-codex/cli' } })
    assert.ok((await api('engine-catalog')).find(item => item.id === 'codex'), 'a pinned bin keeps its engine listed')
  })
})

test('engine detection lists the full registry and onboarding stores the enabled set', async () => {
  await withHost(async ({ api, home }) => {
    const detect = await api('engine-detect')
    assert.ok(detect.find(item => item.id === 'echo'), 'the full registry is listed even when nothing is detectable')
    assert.equal(detect.find(item => item.id === 'echo').usable, false)
    assert.deepEqual(detect.find(item => item.id === 'echo').catalog, null)
    const saved = await api('engine-enable-set', { engines: ['codex', 'echo', 'not-an-engine'] })
    assert.deepEqual(saved.enabledEngines, ['codex', 'echo'], 'unknown ids are dropped, registered ones stay')
    assert.equal(typeof saved.onboardedAt, 'number')
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).prefs.enabledEngines, ['codex', 'echo'])
    await api('engine-enable-set', {})
    const prefs = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).prefs
    assert.deepEqual(prefs.enabledEngines, ['codex', 'echo'], 'an empty list only marks onboarding done')
    assert.equal(typeof prefs.onboardedAt, 'number')
  })
})

test('Codex RPC adapter streams one response, resumes, steers and interrupts', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    let driver = createDriver('codex', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('FIRST')
      await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Hello world')
      assert.equal(events.filter(event => event.type === 'text').length, 0, 'completed text must not duplicate streamed text')
      assert.deepEqual(events.find(event => event.type === 'turn/end').usage,
        { inputTokens: 300, outputTokens: 45, cacheReadTokens: 900, cacheWriteTokens: 0, contextUsed: 1200, contextSize: 258400 },
        'Codex usage lands in disjoint buckets with the model context window')
      const sessionId = events.find(event => event.type === 'session' && event.sessionId).sessionId
      driver.dispose()
      events.length = 0
      driver = createDriver('codex', { bin, cwd, driverSessionId: sessionId, onEvent: event => events.push(event) })
      await driver.sendTurn('WAIT')
      assert.equal(await driver.steer('change focus'), 'steered')
      await until(() => events.find(event => event.type === 'turn/end'))
      events.length = 0
      await driver.sendTurn('WAIT')
      await driver.interruptTurn()
      assert.equal((await until(() => events.find(event => event.type === 'turn/end'))).reason, 'interrupted')
    } finally { driver.dispose() }
  })
})

test('Codex acknowledged interrupt without an end closes the connection and marks the stop unconfirmed', { timeout: 15000 }, async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codex', { bin, cwd, env: { CODEX_IGNORE_INTERRUPT: '1' }, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('WAIT')
      const started = Date.now()
      await driver.interruptTurn()
      assert.ok(Date.now() - started >= 4500, 'the driver waits for the engine end before giving up')
      const ends = events.filter(event => event.type === 'turn/end')
      assert.equal(ends.length, 1)
      assert.equal(ends[0].reason, 'interrupted')
      assert.equal(ends[0].unconfirmed, true)
      assert.equal(driver.hasSession(), false)
      events.length = 0
      await driver.sendTurn('FIRST')
      const end = await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(end.reason, 'done')
      assert.equal(end.unconfirmed, undefined)
    } finally { driver.dispose() }
  })
})

test('Codex forwards current reasoning fields without snapshot duplication and includes tool details', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codex', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('EVENTS')
      await until(() => events.some(event => event.type === 'turn/end'))
      assert.equal(events.filter(event => event.type === 'thinking' && event.blockIndex === 0).map(event => event.text).join(''), 'Check route.')
      assert.equal(events.filter(event => event.type === 'thinking' && event.blockIndex === 1).map(event => event.text).join(''), 'Run tool.')
      assert.ok(events.filter(event => event.type === 'thinking').every(event => event.messageId === 'r1'))
      const tools = events.filter(event => event.type === 'tool')
      assert.deepEqual(tools.map(event => [event.callId, event.phase]), [['commandExecution', 'start'], ['commandExecution', 'update'], ['commandExecution', 'update'],
        ['commandExecution', 'end'], ['collabAgentToolCall', 'start'], ['collabAgentToolCall', 'end'], ['mcp', 'start'], ['mcp', 'update'], ['mcp', 'end']])
      assert.equal(tools[0].input, 'echo fixture')
      assert.deepEqual(tools.filter(event => event.outputDelta !== undefined).map(event => event.outputDelta), ['fix', 'ture'])
      assert.deepEqual(tools[3].output, 'fixture')
      assert.deepEqual(tools[5].output, { worker: { status: 'completed' } })
      assert.deepEqual(tools[7].progress, { message: 'halfway' })
      assert.deepEqual(tools[8].output, { content: [{ type: 'text', text: 'mcp done' }] })
      events.length = 0
      await driver.sendTurn('THOUGHT_FALLBACK')
      await until(() => events.some(event => event.type === 'turn/end'))
      assert.deepEqual([0, 1].map(index => events.filter(event => event.type === 'thinking' && event.blockIndex === index).map(event => event.text).join('')),
        ['First paragraph.', 'Second paragraph.'])
    } finally { driver.dispose() }
  })
})

test('Codex image items stay bounded resource references and dynamic tool media keeps its type', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codex', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('MEDIA_FLOW')
      await until(() => events.some(event => event.type === 'turn/end'))
      const tools = events.filter(event => event.type === 'tool' && event.phase === 'end')
      assert.deepEqual(tools.find(event => event.callId === 'view').output, [{ type: 'resource_link', name: 'shot.png', uri: '/workspace/shot.png' }])
      assert.deepEqual(tools.find(event => event.callId === 'gen').output, ['ES08_GENERATED', { type: 'resource_link', name: 'generated.png', uri: '/workspace/generated.png' }])
      assert.deepEqual(tools.find(event => event.callId === 'dyn').output.map(item => item.type), ['inputText', 'inputImage'])
    } finally { driver.dispose() }
  })
})

test('Codex approvals and multi-question answers round-trip through the host', async () => {
  await withFixture(async ({ bin, cwd }) => withHost(async ({ api, post, home }) => {
    const workspace = await api('workspace-create', { name: 'Fixture', cwd })
    const profile = await api('profile-create', { name: 'Fixture', engine: 'codex', workspace: workspace.id, engineOptions: { bin } })
    await api('send', { profile: profile.id, text: 'ASK_PERMISSION' })
    const card = await until(async () => (await api('state')).approvals[0])
    assert.equal(card.kind, 'permission')
    await api('approval-answer', { id: card.id, decision: 'allow' })
    await until(async () => !(await api('state')).work[profile.id].active)
    assert.ok((await api('transcript', { profile: profile.id })).some(line => line.text === 'Approved'))
    await api('send', { profile: profile.id, text: 'ASK_QUESTIONS' })
    const question = await until(async () => (await api('state')).approvals[0])
    const bad = await post('approval-answer', { id: question.id, decision: 'answer', value: 'invalid json' })
    assert.equal(bad.ok, false)
    assert.equal((await api('state')).approvals.length, 1, 'failed answer must keep the card open')
    await api('approval-answer', { id: question.id, decision: 'answer', value: JSON.stringify({ q1: 'one', q2: 'two' }) })
    await until(async () => !(await api('state')).work[profile.id].active)
    assert.ok((await api('transcript', { profile: profile.id })).some(line => line.text === 'Answered q1,q2'))
    assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).profiles[profile.id].driverSessionId, 'fixture-thread')
  }))
})

test('Codex closes an answered card while the turn runs on', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('codex', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('ASK_PERMISSION')
      const card = await until(() => events.find(event => event.type === 'request/opened'))
      assert.equal(await driver.respondToRequest(card.id, { decision: 'allow' }), true)
      assert.ok(events.some(event => event.type === 'request/closed' && event.id === card.id),
        'the answer itself must close the card: the request is already deleted when the daemon\'s serverRequest/resolved arrives')
      const end = await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(end.reason, 'done')
      assert.equal(events.filter(event => event.type === 'request/closed').length, 1, 'the daemon\'s resolved must not close the deleted request again')
    } finally { driver.dispose() }
  })
})

test('Every engine declares exactly the optional primitives its driver implements', () => {
  for (const item of engineCatalog()) {
    const driver = createDriver(item.id, {})
    for (const name of OPTIONAL_METHODS) {
      assert.equal(hasOptionalMethod(driver, name), item.capabilities?.[name] === true, `${item.id}: ${name}`)
    }
  }
})

test('Every engine declares commands exactly when it has a command scanner', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-caps-home-'))
  const keys = ['HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'DSH_HOME', 'DSH_AGENTS_HOME']
  const previous = keys.map(key => process.env[key])
  process.env.HOME = home
  process.env.CODEX_HOME = join(home, '.codex')
  process.env.XDG_CONFIG_HOME = join(home, 'xdg')
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
  delete process.env.DSH_HOME
  delete process.env.DSH_AGENTS_HOME
  try {
    for (const item of engineCatalog()) {
      const scan = await scanEngineCommands(item.id, {})
      assert.equal(scan.source !== 'unsupported', item.capabilities?.commands === true, `${item.id}: commands`)
    }
  } finally {
    for (const [index, key] of keys.entries()) {
      if (previous[index] === undefined) delete process.env[key]
      else process.env[key] = previous[index]
    }
    rmSync(home, { recursive: true, force: true })
  }
})
