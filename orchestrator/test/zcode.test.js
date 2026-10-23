import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { engineCatalog, validateEngineOptions, checkEngine, createDriver, scanEngine } from '../agent-drivers/dist/index.js'
import { findZcodeExecutable } from '../agent-drivers/dist/zcode/index.js'
import { zcodeProviderEnv } from '../agent-drivers/dist/zcode/native.js'
import { withHost, boot, until } from './helpers/host.js'

const withFixture = async run => {
  const cwd = mkdtempSync(join(tmpdir(), 'orch-zcode-fixture-'))
  const bin = join(cwd, 'zcode')
  copyFileSync(new URL('./fixtures/zcode-cli.cjs', import.meta.url), bin)
  chmodSync(bin, 0o755)
  const home = process.env.HOME
  process.env.HOME = cwd
  try { await run({ bin, cwd }) } finally { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; rmSync(cwd, { recursive: true, force: true }) }
}

test('ZCode file input starts visibly before arguments finish and keeps the final input', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('zcode', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('FILE_INPUT')
      const started = await until(() => events.find(event => event.type === 'tool' && event.phase === 'start'))
      assert.equal(started.name, 'Write')
      assert.ok(!events.some(event => event.type === 'turn/end'), 'the start arrives while the file input is still being generated')
      await until(() => events.some(event => event.type === 'turn/end'))
      const tools = events.filter(event => event.type === 'tool')
      assert.deepEqual(tools.map(event => event.phase), ['start', 'update', 'update', 'end'])
      assert.equal(tools[1].inputDelta, '{"file_path":')
      assert.deepEqual(tools[2].input, { file_path: '/tmp/fixture.txt', content: 'hello' })
      assert.equal(tools[3].input.file_path, '/tmp/fixture.txt')
      assert.equal(tools[3].output, 'written')
    } finally { driver.dispose() }
  })
})

test('ZCode reports network retries and the terminal failure', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('zcode', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('NETWORK_RETRY')
      await until(() => events.some(event => event.type === 'turn/end'))
      const retries = events.filter(event => event.type === 'lifecycle' && event.kind === 'retry' && event.phase === 'start')
      assert.deepEqual(retries.map(event => (event.detail.match(/第 (\d)\/3 次/) ?? [])[1]), ['1', '2', '3'],
        'every retry announcement rides the status channel, including one after recovered output')
      assert.equal(events.some(event => event.type === 'note'), false, 'retries never write feed notes')
      assert.equal(events.find(event => event.type === 'turn/end').error, 'network unavailable')
    } finally { driver.dispose() }
  })
})

test('ZCode checks silent turns without failing long thinking and detects a stopped or unresponsive runtime', async () => {
  await withFixture(async ({ bin, cwd }) => {
    for (const env of [{}, { FIXTURE_HEALTH_IDLE: '1' }, { FIXTURE_HEALTH_HANG: '1' }, { FIXTURE_HEALTH_UNSUPPORTED: '1' }, { FIXTURE_HEALTH_LATE: '1' }]) {
      const events = []
      const driver = createDriver('zcode', { bin, cwd, env, healthIntervalMs: 30, healthTimeoutMs: 80, onEvent: event => events.push(event) })
      try {
        await driver.sendTurn('WAIT')
        if (env.FIXTURE_HEALTH_IDLE || env.FIXTURE_HEALTH_HANG) {
          const ended = await until(() => events.find(event => event.type === 'turn/end'))
          assert.equal(ended.reason, 'error')
          assert.match(ended.error, /停止运行|状态检查失败/)
        } else {
          await until(() => readFileSync(join(cwd, 'session-ledger'), 'utf8').includes('health-read'))
          await new Promise(resolve => setTimeout(resolve, env.FIXTURE_HEALTH_LATE ? 220 : 100))
          assert.equal(events.some(event => event.type === 'turn/end'), false, 'silence and unsupported health queries are not proof of failure')
          if (env.FIXTURE_HEALTH_LATE) assert.ok(events.some(event => event.type === 'delta'), 'live output supersedes an older failed status check')
          assert.equal(events.some(event => event.type === 'note'), false, 'probe outcomes ride the running dock, never the feed')
          await driver.interruptTurn()
          assert.equal(events.find(event => event.type === 'turn/end').reason, 'interrupted')
        }
      } finally { driver.dispose() }
    }
  })
})

test('ZCode coalesces simultaneous stop signals into one engine request', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('zcode', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('WAIT')
      await Promise.all([driver.interruptTurn(), driver.interruptTurn()])
      assert.equal(readFileSync(join(cwd, 'stop-ledger'), 'utf8'), 'session/stop\n')
      assert.equal(events.filter(event => event.type === 'turn/end').length, 1)
      assert.equal(events.find(event => event.type === 'turn/end').reason, 'interrupted')
    } finally { driver.dispose() }
  })
})

test('ZCode metadata traffic cannot suppress silent-turn health checks', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('zcode', { bin, cwd, env: { FIXTURE_HEALTH_METADATA: '1' },
      healthIntervalMs: 30, healthTimeoutMs: 80, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('WAIT')
      await new Promise(resolve => setTimeout(resolve, 200))
      await until(() => readFileSync(join(cwd, 'session-ledger'), 'utf8').includes('health-read'))
      assert.equal(events.some(event => event.type === 'turn/end'), false, 'metadata without progress must not postpone the probe forever')
      await driver.interruptTurn()
      assert.equal(events.find(event => event.type === 'turn/end').reason, 'interrupted')
    } finally { driver.dispose() }
  })
})

test('two silent ZCode sessions keep health checks and stopping independent', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = [[], []]
    const drivers = events.map((stream, index) => {
      const workspace = join(cwd, String(index))
      mkdirSync(workspace)
      return createDriver('zcode', { bin, cwd: workspace, env: { FIXTURE_HEALTH_METADATA: '1' },
        healthIntervalMs: 30, healthTimeoutMs: 80, onEvent: event => stream.push(event) })
    })
    const healthReads = index => {
      try { return readFileSync(join(cwd, String(index), 'session-ledger'), 'utf8').split('health-read').length - 1 }
      catch { return 0 }
    }
    try {
      await Promise.all(drivers.map(driver => driver.sendTurn('WAIT')))
      await until(() => healthReads(0) > 0 && healthReads(1) > 0)
      const before = healthReads(1)
      await drivers[0].interruptTurn()
      assert.equal(events[0].find(event => event.type === 'turn/end').reason, 'interrupted')
      await until(() => healthReads(1) > before)
      assert.equal(events[1].some(event => event.type === 'turn/end'), false)
      await drivers[1].interruptTurn()
      assert.equal(events[1].find(event => event.type === 'turn/end').reason, 'interrupted')
    } finally { drivers.forEach(driver => driver.dispose()) }
  })
})

test('a written approval that remains pending in the engine fails explicitly', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('zcode', { bin, cwd, env: { FIXTURE_LOST_APPROVAL: '1' }, healthIntervalMs: 30, healthTimeoutMs: 80, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('ASK_PERMISSION')
      const card = await until(() => events.find(event => event.type === 'request/opened'))
      assert.equal(await driver.respondToRequest(card.id, { decision: 'allow' }), true)
      const ended = await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(ended.reason, 'error')
      assert.match(ended.error, /应答未获 Agent 确认/)
      assert.equal(driver.hasSession(), false)
    } finally { driver.dispose() }
  })
})

test('an approval opened by a failed boot is closed and cannot reach a later connection', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('zcode', { bin, cwd, env: { FIXTURE_BOOT_CARD: '1' }, onEvent: event => events.push(event) })
    try {
      await assert.rejects(driver.sendTurn('X'), /fixture boot failed/)
      const card = await until(() => events.find(event => event.type === 'request/opened'))
      await until(() => events.some(event => event.type === 'request/closed' && event.id === card.id))
      await driver.sendTurn('NOSTREAM')
      await until(() => events.some(event => event.type === 'turn/end'))
      assert.equal(await driver.respondToRequest(card.id, { decision: 'allow' }), false, 'the orphan card died with its failed boot')
      assert.equal(events.filter(event => event.type === 'request/missed').length, 1)
      await driver.sendTurn('FIRST')
      await until(() => events.filter(event => event.type === 'turn/end').length === 2)
      assert.equal(driver.hasSession(), true, 'the stale reply must not disturb the live connection')
    } finally { driver.dispose() }
  })
})

test('host recreates a missing blank ZCode runtime without replacing its session or role', async () => {
  await withFixture(async ({ bin, cwd }) => withHost(async host => {
    writeFileSync(join(cwd, 'defer-empty'), '')
    const workspace = await host.api('workspace-create', { name: 'Blank recovery', cwd })
    const profile = await host.api('profile-create', { name: 'Blank ZCode role', instructions: 'BOUND_EMPTY_ROLE', engine: 'zcode', workspace: workspace.id, permission: 'plan', engineOptions: { bin } })
    const session = await host.api('session-create', { profile: profile.id, workspace: workspace.id })
    await until(() => JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).profiles[profile.id].sessions.find(item => item.id === session.id)?.driverSessionId)
    host.dispose()
    const reopened = boot(host.home)
    try {
      await reopened.api('send', { profile: profile.id, session: session.id, text: 'FIRST_REAL_TASK' })
      await until(async () => !(await reopened.api('state')).work[session.id].active)
      const saved = (await reopened.api('state')).profiles.find(item => item.id === profile.id).sessions.find(item => item.id === session.id)
      assert.equal(saved.instructions, 'BOUND_EMPTY_ROLE')
      assert.equal(saved.identityVersion, session.identityVersion)
      assert.equal(saved.lastTurn.reason, 'done')
      assert.equal(saved.lastTurn.task, 'FIRST_REAL_TASK')
      const requests = readFileSync(join(cwd, 'zcode-mcp-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      assert.deepEqual(requests.map(entry => entry.method), ['session/create', 'session/resume', 'session/create'])
      assert.equal(requests[2].params.mode, 'plan')
      assert.deepEqual(requests[2].params.mcpServers, requests[0].params.mcpServers)
    } finally { reopened.dispose() }
    writeFileSync(join(cwd, 'zcode-empty'), '')
    const nonempty = boot(host.home)
    try {
      await nonempty.api('send', { profile: profile.id, session: session.id, text: 'SECOND_TASK' })
      await until(async () => !(await nonempty.api('state')).work[session.id].active)
      const saved = (await nonempty.api('state')).profiles.find(item => item.id === profile.id).sessions.find(item => item.id === session.id)
      assert.equal(saved.lastTurn.reason, 'error', 'a missing nonempty session must not become a new conversation')
      const requests = readFileSync(join(cwd, 'zcode-mcp-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      assert.equal(requests.filter(entry => entry.method === 'session/create').length, 2)
    } finally { nonempty.dispose() }
  }))
})

test('host uses the discovered ZCode role tool schema from the first task through compaction and restart', async () => {
  await withFixture(async ({ bin, cwd }) => withHost(async host => {
    writeFileSync(join(cwd, 'fixture-native-role'), '')
    const workspace = await host.api('workspace-create', { name: 'Role tool identity', cwd })
    const profile = await host.api('profile-create', { name: 'Role tool coder', instructions: 'ROLE_SCHEMA_ONLY', engine: 'zcode', workspace: workspace.id, engineOptions: { bin } })
    await host.api('send', { profile: profile.id, text: 'FIRST_TASK' })
    await until(async () => !(await host.api('state')).work[profile.id].active)
    await host.api('session-compact', { profile: profile.id })
    host.dispose()
    const reopened = boot(host.home)
    try {
      await reopened.api('send', { profile: profile.id, text: 'RESUMED_TASK' })
      await until(async () => !(await reopened.api('state')).work[profile.id].active)
      const saved = (await reopened.api('state')).profiles.find(item => item.id === profile.id).sessions[0]
      assert.equal(saved.instructionMode, 'native')
      assert.equal(saved.instructionTarget, 'tool-schema')
      const tasks = readFileSync(join(cwd, 'zcode-turns.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      assert.equal(tasks[0].content, 'FIRST_TASK')
      assert.ok(tasks[1].content.endsWith('RESUMED_TASK'))
      assert.ok(tasks.every(item => !item.content.includes('ROLE_SCHEMA_ONLY')))
      const entries = readFileSync(join(cwd, 'zcode-mcp-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      const paths = entries.map(item => item.params.mcpServers[0].env.find(item => item.name === 'NODO_ROLE_FILE').value)
      assert.equal(paths[0], paths[1], 'a resumed session reuses the shared complete identity version')
    } finally { reopened.dispose() }
  }))
})

test('ZCode never recreates a missing session without empty-session authorization or after sending a task', async () => {
  await withFixture(async ({ bin, cwd }) => {
    for (const env of [{ FIXTURE_RESUME_NOT_FOUND: '1' }, { FIXTURE_RESUME_FAILURE: '1' }]) {
      const driver = createDriver('zcode', { bin, cwd, driverSessionId: 'gone', allowEmptyResume: Boolean(env.FIXTURE_RESUME_FAILURE), env })
      try { await assert.rejects(driver.openSession(), /Session (not found|store unavailable)/) }
      finally { driver.dispose() }
    }
    assert.throws(() => readFileSync(join(cwd, 'session-ledger')), /ENOENT/)
    const events = []
    const driver = createDriver('zcode', { bin, cwd, allowEmptyResume: true, env: { FIXTURE_RESUME_NOT_FOUND: '1' }, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('EXIT')
      await until(() => events.some(event => event.type === 'turn/end'))
      await assert.rejects(driver.sendTurn('AFTER_EXIT'), /Session not found/)
      assert.equal(readFileSync(join(cwd, 'session-ledger'), 'utf8').match(/create:/g).length, 1)
    } finally { driver.dispose() }
  })
})

test('ZCode binds role MCP to create and resume, keeping message identity fallback', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const instructions = 'Bound coder identity\n{{literal}} {env:UNSET}'
    for (const driverSessionId of [undefined, 'fixture-zcode-session']) {
      const driver = createDriver('zcode', { bin, cwd, driverSessionId, instructions, permission: 'plan' })
      try {
        await driver.openSession()
        assert.equal(driver.instructionMode, 'none', 'MCP attachment alone cannot prove native system persistence')
        const entries = readFileSync(join(cwd, 'zcode-mcp-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
        const [server] = entries.at(-1).params.mcpServers
        assert.equal(server.env[0].name, 'NODO_ROLE_FILE')
        assert.equal(readFileSync(server.env[0].value, 'utf8'), instructions)
      } finally { driver.dispose() }
    }
    const entries = readFileSync(join(cwd, 'zcode-mcp-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(entries.map(entry => entry.method), ['session/create', 'session/resume'])
    for (const { params } of entries) {
      assert.equal(params.mcpServers.length, 1)
      const [server] = params.mcpServers
      assert.equal(server.isolation, 'session')
      assert.equal(server.protocolVersion, 'legacy')
      assert.equal(server.env.length, 1)
      assert.equal(server.env[0].name, 'NODO_ROLE_FILE')
      assert.equal(JSON.stringify(server.env).includes(instructions), false)
      assert.equal(JSON.stringify(server.args).includes(instructions), false)
    }
  })
})

test('ZCode downgrades only an explicitly unsupported MCP field, preserving permissions and resume', async () => {
  await withFixture(async ({ bin, cwd }) => {
    for (const driverSessionId of [undefined, 'fixture-zcode-session']) {
      const driver = createDriver('zcode', { bin, cwd, driverSessionId, instructions: 'Role', permission: 'plan', env: { FIXTURE_VERSION: '0.16.9', FIXTURE_NO_ROLE_MCP: '1' } })
      try {
        await driver.openSession()
        assert.equal(driver.instructionMode, 'none')
      } finally { driver.dispose() }
    }
    assert.equal(readFileSync(join(cwd, 'session-ledger'), 'utf8'), 'mode plan\ncreate:refused:answered\nsession/resume\nmode plan\n')
    const failed = createDriver('zcode', { bin, cwd, instructions: 'Role', env: { FIXTURE_ROLE_MCP_FAILURE: '1' } })
    try { await assert.rejects(failed.openSession(), /MCP connection failed/); assert.equal(failed.hasSession(), false) }
    finally { failed.dispose() }
  })
})

test('ZCode catalog, options and non-task protocol check describe actual capabilities', async () => {
  const info = engineCatalog().find(item => item.id === 'zcode')
  assert.deepEqual(info.capabilities, { resume: true, steer: true, permissions: true, questions: true, commands: true, compact: true, permissionModes: ['plan', 'workspace', 'full'] })
  assert.deepEqual(validateEngineOptions('zcode', {}), {})
  for (const options of [{ socket: '/tmp/sock' }, { args: ['--yolo'] }, { bin: 'zcode --flag' }]) assert.throws(() => validateEngineOptions('zcode', options))
  await withFixture(async ({ bin, cwd }) => {
    const check = await checkEngine({ engine: 'zcode', cwd, engineOptions: { bin } })
    assert.equal(check.ok, true)
    assert.equal(check.executable, bin)
    assert.equal(check.version, 'zcode fixture')
    assert.equal(check.checks.find(item => item.label === 'Model / credentials').ok, null)
    assert.throws(() => readFileSync(join(cwd, 'session-ledger')), /ENOENT/, 'check must not create a conversation')
    assert.equal((await checkEngine({ engine: 'zcode', cwd, engineOptions: { bin: join(cwd, 'missing') } })).ok, false)
  })
})

test('the autonomy tier rides session/create as the engine permission mode', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const cases = [['plan', 'plan'], ['full', 'yolo'], ['workspace', 'guarded'], [undefined, 'build']]
    for (const [permission] of cases) {
      const events = []
      const driver = createDriver('zcode', { bin, cwd, permission, onEvent: event => events.push(event) })
      try {
        await driver.sendTurn('X')
        await until(() => events.find(event => event.type === 'turn/end'))
      } finally { driver.dispose() }
    }
    const ledger = readFileSync(join(cwd, 'session-ledger'), 'utf8')
    for (const [, mode] of cases) assert.ok(ledger.includes(`mode ${mode}\n`), `the tier was requested as mode ${mode}`)
  })
})

test('ZCode V4 guides are observed through injection or engine queue completion', async () => {
  for (const queued of [false, true]) await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('zcode', { bin, cwd, env: { FIXTURE_V4_GUIDE: '1', ...(queued ? { FIXTURE_V4_QUEUE: '1' } : {}) }, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('WAIT')
      assert.equal(await driver.steer('new direction'), 'steered')
      assert.equal(events.some(event => event.type === 'turn/end'), false, 'acceptance and the old completion do not finish pending input')
      const end = await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(end.reason, 'done')
      assert.ok(events.some(event => event.type === 'text' && event.text === 'Steered new direction'))
      assert.equal(end.usage.outputTokens, queued ? 6 : 3)
      assert.equal(events.filter(event => event.type === 'turn/start').length, 1)
    } finally { driver.dispose() }
  })
})

test('ZCode rejects unaccepted guides and V4 stop holds an accepted engine queue', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('zcode', { bin, cwd, env: { FIXTURE_V4_GUIDE: '1' }, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('WAIT')
      assert.equal(await driver.steer('REJECT'), 'refused')
      assert.equal(await driver.steer('HOLD'), 'steered')
      await driver.interruptTurn()
      assert.equal((await until(() => events.find(event => event.type === 'turn/end'))).reason, 'interrupted')
      assert.ok(readFileSync(join(cwd, 'session-ledger'), 'utf8').includes('v4 stop'))
    } finally { driver.dispose() }
  })
})

test('a guide turn that fails after a finished segment keeps that segment\'s usage', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('zcode', { bin, cwd, env: { FIXTURE_V4_GUIDE: '1', FIXTURE_V4_QUEUE: '1', FIXTURE_V4_FAIL: '1' }, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('WAIT')
      assert.equal(await driver.steer('go'), 'steered')
      const end = await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(end.reason, 'error')
      assert.equal(end.usage.outputTokens, 3, 'the completed segment stays counted')
    } finally { driver.dispose() }
  })
})

test('ZCode forwards thinking, streamed tool input, errors and result-only lifecycles', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('zcode', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('EVENTS')
      await until(() => events.some(event => event.type === 'turn/end'))
      assert.equal(events.filter(event => event.type === 'thinking').map(event => event.text).join(''), 'Check route.')
      const tools = events.filter(event => event.type === 'tool')
      assert.deepEqual(tools.map(event => [event.callId, event.phase]), [['a', 'start'], ['a', 'update'], ['a', 'update'], ['a', 'end'], ['b', 'start'], ['b', 'end'], ['c', 'start'], ['c', 'end']])
      assert.deepEqual(tools[0].input, { path: '/tmp/fixture' })
      assert.equal(tools[1].parentCallId, 'parent-call')
      assert.equal(tools[2].parentCallId, 'parent-call')
      assert.deepEqual(tools[2].progress, { elapsedMs: 1500, stdoutTail: 'working', stdoutBytes: 7, stderrBytes: 0 })
      assert.deepEqual(tools[3].output, [{ type: 'text', text: 'file contents' }])
      assert.equal(tools[5].isError, true)
      assert.deepEqual(tools[5].output, { message: 'command failed' })
      assert.equal(tools[7].output, 'result only')
    } finally { driver.dispose() }
  })
})

test('ZCode answers a reply for an unknown ask with a diagnostic and false', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('zcode', { bin, cwd, onEvent: event => events.push(event) })
    try {
      assert.equal(await driver.respondToRequest('zcode:none:missing', { decision: 'allow' }), false)
      const missed = events.find(event => event.type === 'request/missed')
      assert.equal(missed.connected, false)
      assert.deepEqual(missed.pending, [])
    } finally { driver.dispose() }
  })
})

test('ZCode thinking and tool details reach the persisted conversation feed', async () => {
  await withFixture(async ({ bin, cwd }) => withHost(async host => {
    const workspace = await host.api('workspace-create', { name: 'Feed', cwd })
    const profile = await host.api('profile-create', { name: 'Feed', engine: 'zcode', workspace: workspace.id, engineOptions: { bin } })
    await host.api('send', { profile: profile.id, text: 'EVENTS' })
    const lines = await until(async () => {
      const transcript = await host.api('transcript', { profile: profile.id })
      return transcript.some(line => line.who === 'agent' && ['text', 'error'].includes(line.kind)) && transcript
    })
    assert.equal(lines.find(line => line.who === 'agent' && ['text', 'error'].includes(line.kind)).text, 'Events done')
    assert.equal(lines.filter(line => line.kind === 'thinking').map(line => line.text).join(''), 'Check route.')
    assert.match(lines.find(line => line.kind === 'tool' && line.callId === 'a' && line.phase === 'start').input, /\/tmp\/fixture/)
    assert.equal(lines.find(line => line.kind === 'tool' && line.callId === 'a' && line.phase === 'end').output, 'file contents')
    assert.equal(lines.find(line => line.kind === 'tool' && line.callId === 'b' && line.phase === 'end').isError, true)
  }))
})

test('ZCode driver streams replies, tracks tools and usage, resumes and refuses unavailable steer', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    let driver = createDriver('zcode', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.openSession()
      assert.equal(driver.hasSession(), true)
      const sessionId = events.find(event => event.type === 'session' && event.sessionId).sessionId
      assert.equal(sessionId, 'fixture-zcode-session')
      await driver.sendTurn('FIRST')
      const end = await until(() => events.find(event => event.type === 'turn/end'))
      assert.equal(end.reason, 'done')
      assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Hello world')
      assert.equal(events.filter(event => event.type === 'text').length, 0, 'completed text must not duplicate streamed text')
      assert.deepEqual(events.filter(event => event.type === 'tool').map(event => [event.name, event.phase]), [['Bash', 'start'], ['Bash', 'end']])
      assert.deepEqual(end.usage, { inputTokens: 10, outputTokens: 3, contextUsed: 4200, contextSize: 128000 },
        'the boot snapshot\'s context occupancy rides along with the turn tokens')

      events.length = 0
      await driver.sendTurn('USAGE')
      const counted = await until(() => events.find(event => event.type === 'turn/end'))
      assert.deepEqual(counted.usage,
        { inputTokens: 900, outputTokens: 12, cacheReadTokens: 3000, cacheWriteTokens: 100, contextUsed: 5000, contextSize: 200000 },
        'GLM-style whole-prompt input gets its cache side removed and the context snapshot lands in the turn')

      for (const [command, why] of [['SDKCOUNT', 'AI SDK inputTokens is the whole prompt as well'], ['SPLITCOUNT', 'an input the total shows as disjoint stays uncached']]) {
        events.length = 0
        await driver.sendTurn(command)
        const sdk = await until(() => events.find(event => event.type === 'turn/end'))
        assert.deepEqual(sdk.usage, { inputTokens: 900, outputTokens: 12, cacheReadTokens: 3000, cacheWriteTokens: 100, contextUsed: 5000, contextSize: 200000 }, why)
      }

      events.length = 0
      await driver.sendTurn('CUMULATIVE_CACHE')
      const firstCached = await until(() => events.find(event => event.type === 'turn/end'))
      assert.deepEqual(firstCached.usage, { inputTokens: 800, outputTokens: 4, contextUsed: 6000, contextSize: 200000 },
        'before a first cumulative observation there is no cache read to attribute to the turn')

      events.length = 0
      await driver.sendTurn('CUMULATIVE_CACHE')
      const secondCached = await until(() => events.find(event => event.type === 'turn/end'))
      assert.deepEqual(secondCached.usage, { inputTokens: 100, outputTokens: 4, cacheReadTokens: 700, contextUsed: 6000, contextSize: 200000 },
        'a whole-session cacheStats reports its growth since the last turn, not the running total')

      events.length = 0
      await driver.sendTurn('NOSTREAM')
      await until(() => events.some(event => event.type === 'turn/end'))
      assert.equal(events.find(event => event.type === 'text').text, 'Silent reply')
      assert.equal(events.filter(event => event.type === 'delta').length, 0)

      events.length = 0
      await driver.sendTurn('TWO LEAK')
      await until(() => events.some(event => event.type === 'turn/end'))
      assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Hello\nworld')

      events.length = 0
      await driver.sendTurn('WAIT')
      await assert.rejects(driver.sendTurn('SECOND'), /already has a running turn/)
      assert.equal(await driver.steer('change focus'), 'refused')
      await driver.interruptTurn()
      assert.equal((await until(() => events.find(event => event.type === 'turn/end'))).reason, 'interrupted')

      driver.dispose()
      events.length = 0
      driver = createDriver('zcode', { bin, cwd, driverSessionId: sessionId, onEvent: event => events.push(event) })
      await driver.sendTurn('SECOND')
      assert.equal((await until(() => events.find(event => event.type === 'turn/end'))).reason, 'done')
      await driver.compact()
      assert.equal(readFileSync(join(cwd, 'session-ledger'), 'utf8'), 'mode build\ncreate:refused:answered\nsession/resume\nmode build\ncompact\n',
        'a resumed session is re-pointed at the profile tier')
    } finally { driver.dispose() }
  })
})

test('ZCode waits for accepted compaction to finish and propagates failure or disconnect', async () => {
  await withFixture(async ({ bin, cwd }) => {
    for (const extra of [{}, { FIXTURE_COMPACT_ERROR: '1' }, { FIXTURE_COMPACT_EXIT: '1' }]) {
      const events = []
      const driver = createDriver('zcode', { bin, cwd, env: { FIXTURE_ASYNC_COMPACT: '1', ...extra }, onEvent: event => events.push(event) })
      try {
        await driver.openSession()
        let settled = false
        const pending = driver.compact().finally(() => { settled = true })
        pending.catch(() => {})
        await new Promise(resolve => setTimeout(resolve, 30))
        assert.equal(settled, false, 'accepted is not completed')
        const start = events.find(event => event.type === 'turn/start' && String(event.turnId).startsWith('zcode-compact-'))
        assert.ok(start, 'an accepted compaction announces its turn lifetime')
        await assert.rejects(driver.sendTurn('TOO_EARLY'), /compacting/)
        await assert.rejects(driver.compact(), /running turn or compaction/)
        if (Object.keys(extra).length) {
          const end = await until(() => events.find(event => event.type === 'turn/end' && String(event.turnId).startsWith('zcode-compact-')))
          assert.equal(end.turnId, start.turnId, 'the compaction turn pairs on one id')
          assert.equal(end.reason, 'error')
          await assert.rejects(pending, /compact|CLI exited/)
        } else {
          await pending
          const end = events.find(event => event.type === 'turn/end' && String(event.turnId).startsWith('zcode-compact-'))
          assert.equal(end.reason, 'done')
          assert.equal(end.turnId, start.turnId)
          await driver.sendTurn('AFTER_COMPACT')
        }
      } finally { driver.dispose() }
    }
  })
})

test('ZCode permissions and questions round-trip through the host', async () => {
  await withFixture(async ({ bin, cwd }) => withHost(async host => {
    const workspace = await host.api('workspace-create', { name: 'Fixture', cwd })
    const profile = await host.api('profile-create', { name: 'ZCode', engine: 'zcode', workspace: workspace.id, engineOptions: { bin } })
    for (const [decision, reply] of [['allow', 'Approved'], ['deny', 'Denied']]) {
      await host.api('send', { profile: profile.id, text: 'ASK_PERMISSION' })
      const card = await until(async () => (await host.api('state')).approvals[0])
      assert.equal(card.kind, 'permission')
      assert.equal(card.tool, 'Bash')
      await host.api('approval-answer', { id: card.id, decision })
      await until(async () => !(await host.api('state')).work[profile.id].active)
      const transcript = await host.api('transcript', { profile: profile.id })
      assert.ok(transcript.some(line => line.text === reply))
      assert.equal((await host.api('state')).approvals.length, 0)
    }
    await host.api('send', { profile: profile.id, text: 'ASK_QUESTION' })
    const question = await until(async () => (await host.api('state')).approvals[0])
    assert.equal(question.kind, 'question')
    assert.deepEqual(question.detail.questions, [{ id: 'q0', question: 'Favorite color?', header: 'Color' }])
    const bad = await host.post('approval-answer', { id: question.id, decision: 'answer', value: '  ' })
    assert.equal(bad.ok, false)
    assert.equal((await host.api('state')).approvals.length, 1, 'failed answer must keep the card open')
    await host.api('approval-answer', { id: question.id, decision: 'answer', value: 'blue' })
    await until(async () => !(await host.api('state')).work[profile.id].active)
    assert.ok((await host.api('transcript', { profile: profile.id })).some(line => line.text === 'Answered blue'))
    await host.api('send', { profile: profile.id, text: 'ASK_MULTI' })
    const multi = await until(async () => (await host.api('state')).approvals[0])
    assert.deepEqual(multi.detail.questions, [
      { id: 'q0', question: 'Pick a color?', header: 'Color', options: [{ label: 'Blue' }, { label: 'Red' }] },
      { id: 'q1', question: 'Pick a size?', header: 'Size', options: [{ label: 'Big' }] },
    ])
    await host.api('approval-answer', { id: multi.id, decision: 'answer', value: JSON.stringify({ q0: 'Blue', q1: 'Big' }) })
    await until(async () => !(await host.api('state')).work[profile.id].active)
    assert.ok((await host.api('transcript', { profile: profile.id })).some(line => line.text === 'Answered Blue/Big'))
    await host.api('send', { profile: profile.id, text: 'ASK_PERMISSION' })
    await until(async () => (await host.api('state')).approvals[0])
    await host.api('interrupt', { profile: profile.id })
    assert.equal((await host.api('state')).approvals.length, 0)
    host.dispose()
    const reopened = boot(host.home)
    try {
      assert.equal((await reopened.api('state')).profiles.find(item => item.id === profile.id).driverSessionId, 'fixture-zcode-session')
      await reopened.api('send', { profile: profile.id, text: 'AFTER_RESTART' })
      await until(async () => !(await reopened.api('state')).work[profile.id].active)
      assert.ok(readFileSync(join(cwd, 'session-ledger'), 'utf8').includes('session/resume'))
    } finally { reopened.dispose() }
  })
  )
})

test('ZCode rejects unknown saved sessions and malformed model selectors without silently replacing them', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const stale = createDriver('zcode', { bin, cwd, driverSessionId: 'sess-gone', onEvent: event => events.push(event) })
    try { await assert.rejects(stale.sendTurn('FIRST'), /Unknown session/); assert.equal(stale.hasSession(), false) }
    finally { stale.dispose() }
    const badModel = createDriver('zcode', { bin, cwd, model: 'just-a-model-name' })
    try { await assert.rejects(badModel.sendTurn('FIRST'), /providerId\$modelId/); assert.equal(badModel.hasSession(), false) }
    finally { badModel.dispose() }
    const events2 = []
    const jsonModel = createDriver('zcode', { bin, cwd, model: '{"providerId":"mock","modelId":"glm-test"}', onEvent: event => events2.push(event) })
    try {
      await jsonModel.sendTurn('FIRST')
      await until(() => events2.some(event => event.type === 'turn/end'))
      // A model selection carries the model's own default level: ZCode rejects a
      // selection without one.
      assert.equal(readFileSync(join(cwd, 'session-ledger'), 'utf8'), 'mode build\ncreate:refused:answered\nmodel mock$glm-test\neffort high\n')
    } finally { jsonModel.dispose() }
  })
})

test('ZCode scan lists models with their thought levels, and a chosen level reaches the session', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const catalog = await scanEngine('zcode', { engineOptions: { bin }, cwd })
    assert.equal(catalog.source, 'ZCode session model list')
    assert.equal(catalog.defaultModel, 'mock$glm-test')
    assert.deepEqual(catalog.models.map(model => model.id), ['mock$glm-test', 'mock$glm-fast'])
    assert.equal(catalog.models[0].label, 'glm-test', 'the label is the model name, the provider stays in the id')
    assert.equal(catalog.models[0].group, 'Mock', 'the provider is the section the model sits under')
    assert.deepEqual(catalog.models[0].thinking.map(level => level.id), ['disabled', 'high'])
    assert.equal(catalog.models[0].defaultThinking, 'high')
    assert.deepEqual(catalog.models[1].thinking.map(level => level.id), ['low', 'max'])
    assert.equal(catalog.models[1].defaultThinking, undefined, 'a model without a default level offers none')
    assert.ok(readFileSync(join(cwd, 'session-ledger'), 'utf8').endsWith('session/close\n'), 'the scan leaves no open session')
    const events = []
    const driver = createDriver('zcode', { bin, cwd, model: 'mock$glm-fast', thinking: 'max', onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('FIRST')
      await until(() => events.some(event => event.type === 'turn/end'))
      assert.ok(readFileSync(join(cwd, 'session-ledger'), 'utf8').includes('model mock$glm-fast\neffort max\n'))
    } finally { driver.dispose() }
    const levels = createDriver('zcode', { bin, cwd, thinking: 'low' })
    try {
      await levels.sendTurn('FIRST')
      assert.ok(readFileSync(join(cwd, 'session-ledger'), 'utf8').includes('thought low\n'))
    } finally { levels.dispose() }
  })
})

test('ZCode executable discovery checks PATH first and then the app bundle', async () => {
  await withFixture(async ({ cwd, bin }) => {
    assert.equal(findZcodeExecutable(bin, { home: cwd, path: '' }), bin)
    assert.equal(findZcodeExecutable(join(cwd, 'missing'), { home: cwd, path: '' }), undefined)
    const bundle = findZcodeExecutable('zcode', { home: cwd, path: '' })
    assert.ok(bundle === undefined || bundle.endsWith('zcode.cjs'))
  })
})

test('ZCode spawn env resolves the built-in provider config the CLI cannot find alone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-zcode-provider-'))
  try {
    const stale = join(root, '.zcode/v2/runtime/provider/darwin-aarch64/3.14.0/endpoint-a/zcode-builtin.json')
    const fresh = join(root, '.zcode/v2/runtime/provider/darwin-aarch64/3.15.3/endpoint-b/zcode-builtin.json')
    for (const file of [stale, fresh]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, '{}') }
    utimesSync(stale, new Date(Date.now() - 60000), new Date(Date.now() - 60000))
    const options = { home: root, platform: 'darwin', arch: 'aarch64', env: {} }
    assert.deepEqual(zcodeProviderEnv(options), { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fresh })
    assert.deepEqual(zcodeProviderEnv({ ...options, env: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: stale } }), {}, 'a valid inherited path is respected')
    assert.deepEqual(zcodeProviderEnv({ ...options, env: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(root, 'gone.json') } }), { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fresh })
    assert.deepEqual(zcodeProviderEnv({ home: join(root, 'empty'), platform: 'linux', arch: 'x64', env: {} }), {}, 'no runtime, no injection')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ZCode check reports why the app-server died instead of a bare exit code', async () => {
  await withFixture(async ({ bin, cwd }) => {
    process.env.FIXTURE_EXIT_APPSERVER = '1'
    try {
      const check = await checkEngine({ engine: 'zcode', cwd, engineOptions: { bin } })
      assert.equal(check.ok, false)
      assert.match(check.checks.find(item => item.label === 'Protocol').message, /CLI exited \(1\): fixture: cannot locate provider config/)
      await assert.rejects(scanEngine('zcode', { engineOptions: { bin }, cwd }), /CLI exited \(1\): fixture: cannot locate provider config/)
    } finally { delete process.env.FIXTURE_EXIT_APPSERVER }
  })
})
