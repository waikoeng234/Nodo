import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { engineCatalog, validateEngineOptions, checkEngine, createDriver, scanEngine } from '../agent-drivers/dist/index.js'
import { findDshExecutable } from '../agent-drivers/dist/dsh/index.js'
import { withHost, boot, until } from './helpers/host.js'

const withFixture = async run => {
  const cwd = mkdtempSync(join(tmpdir(), 'orch-dsh-fixture-'))
  const bin = join(cwd, 'dsh')
  copyFileSync(new URL('./fixtures/dsh-cli.cjs', import.meta.url), bin)
  chmodSync(bin, 0o755)
  try { await run({ bin, cwd }) } finally { rmSync(cwd, { recursive: true, force: true }) }
}

test('DSH ACP retains confirmed standard diffs across partial tool updates without counting failed or duplicate results', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('dsh', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('FILES')
      await until(() => events.some(event => event.type === 'turn/end'))
      const body = events.find(event => event.type === 'changes').presentation.body
      assert.equal(body.fileCount, 1)
      assert.deepEqual(body.files[0], { path: join(cwd, 'edited.txt'), edits: [{ operation: 'update', oldText: 'before', newText: 'after' }] })
    } finally { driver.dispose() }
  })
})

test('DSH ACP identity patch preserves storage configuration, reloads on resume and is private', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const instructions = 'Review evidence. '.repeat(110) + 'TAIL_ACP_RULE'
    const events = []
    const options = { bin, cwd, storageDir: join(cwd, 'storage'), instructions, onEvent: event => events.push(event) }
    let driver = createDriver('dsh', options)
    let firstPatch
    try {
      await driver.sendTurn('FIRST')
      await until(() => events.some(event => event.type === 'turn/end'))
      assert.equal(driver.instructionMode, 'native')
      const first = JSON.parse(readFileSync(join(cwd, 'dsh-requests.jsonl'), 'utf8').split('\n')[0])
      firstPatch = first.patchPath
      assert.equal(first.personaPrefix, instructions)
      assert.equal(statSync(firstPatch).mode & 0o777, 0o600)
      const patch = JSON.parse(readFileSync(firstPatch, 'utf8'))
      assert.equal(patch.find(item => item.id === 'session-persistence-jsonl').config.root, join(cwd, 'storage/dsh/sessions'))
      assert.equal(patch.find(item => item.id === 'system-prompt').config.personaPrefix, instructions)
      const sessionId = events.find(event => event.sessionId).sessionId
      driver.dispose()
      assert.equal(existsSync(firstPatch), false)
      events.length = 0
      driver = createDriver('dsh', { ...options, driverSessionId: sessionId })
      await driver.sendTurn('SECOND')
      await until(() => events.some(event => event.type === 'turn/end'))
      const requests = readFileSync(join(cwd, 'dsh-requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      const resume = requests.find(item => item.method === 'session/resume')
      assert.equal(resume.personaPrefix, instructions)
      assert.notEqual(resume.patchPath, firstPatch)
      assert.deepEqual(requests.filter(item => item.method === 'session/prompt').map(item => item.text), ['FIRST', 'SECOND'])
    } finally { driver.dispose() }
  })
})

test('standalone ACP host uses native identity without copying it into any task', async () => {
  await withFixture(async ({ bin, cwd }) => withHost(async host => {
    const workspace = await host.api('workspace-create', { name: 'Identity', cwd })
    const role = await host.api('profile-create', { name: 'ACP', engine: 'dsh', workspace: workspace.id, instructions: 'Keep the role', engineOptions: { bin } })
    for (const text of ['FIRST', 'SECOND']) {
      await host.api('send', { profile: role.id, text })
      await until(async () => !(await host.api('state')).work[role.id].active)
    }
    const requests = readFileSync(join(cwd, 'dsh-requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.match(requests[0].personaPrefix, /Keep the role/)
    const prompts = requests.filter(item => item.method === 'session/prompt')
    assert.equal(prompts[0].text, 'FIRST')
    assert.equal(prompts[1].text, 'SECOND')
  }))
})

test('ACP template literals run without identity instead of interpreting or copying instructions', async () => {
  await withFixture(async ({ bin, cwd }) => withHost(async host => {
    const workspace = await host.api('workspace-create', { name: 'Literal', cwd })
    const role = await host.api('profile-create', { name: 'Literal', engine: 'dsh', workspace: workspace.id, instructions: 'Keep {{literal}} intact', engineOptions: { bin } })
    for (const text of ['FIRST', 'SECOND']) {
      await host.api('send', { profile: role.id, text })
      await until(async () => !(await host.api('state')).work[role.id].active)
    }
    const requests = readFileSync(join(cwd, 'dsh-requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(requests[0].personaPrefix, undefined)
    assert.deepEqual(requests.filter(item => item.method === 'session/prompt').map(item => item.text), ['FIRST', 'SECOND'])
  }))
})

test('DSH catalog, options and non-task protocol check describe actual capabilities', async () => {
  const info = engineCatalog().find(item => item.id === 'dsh')
  assert.deepEqual(info.capabilities, { resume: true, steer: false, permissions: true, questions: false, commands: true, permissionModes: [] })
  assert.deepEqual(validateEngineOptions('dsh', {}), { profile: 'acp' })
  for (const options of [{ args: ['--yolo'] }, { profile: '../desktop' }, { home: '.' }, { bin: 'dsh --profile web' }]) assert.throws(() => validateEngineOptions('dsh', options))
  await withFixture(async ({ bin, cwd }) => {
    const check = await checkEngine({ engine: 'dsh', cwd, engineOptions: { bin } })
    assert.equal(check.ok, true)
    assert.equal(check.version, 'dsh fixture')
    assert.equal(check.checks.find(item => item.label === 'Model / credentials').ok, null)
    assert.throws(() => readFileSync(join(cwd, 'session-ledger')), /ENOENT/, 'check must not create a conversation')
    assert.equal((await checkEngine({ engine: 'dsh', cwd, engineOptions: { bin: join(cwd, 'missing') } })).ok, false)
  })
})

test('DSH ACP refuses explicit permission overrides before creating a process or session', async () => {
  await withFixture(async ({ bin, cwd }) => withHost(async host => {
    const workspace = await host.api('workspace-create', { name: 'Permissions', cwd })
    for (const permission of ['plan', 'workspace', 'full']) {
      assert.throws(() => createDriver('dsh', { bin, cwd, permission }), /ACP cannot set a session permission tier/)
      const result = await host.post('profile-create', { name: permission, engine: 'dsh', workspace: workspace.id, permission, engineOptions: { bin } })
      assert.equal(result.error.code, 'orch/invalid')
    }
    assert.equal(existsSync(join(cwd, 'session-ledger')), false)
  }))
})

test('DSH host restores isolated ids from their existing role storage without relocating sessions', async () => {
  await withFixture(async ({ bin, cwd }) => withHost(async host => {
    const workspace = await host.api('workspace-create', { name: 'Isolated', cwd })
    const role = await host.api('profile-create', { name: 'Isolated', engine: 'dsh', workspace: workspace.id, engineOptions: { bin } })
    const events = []
    const storageDir = join(host.home, 'agents', role.id)
    const driver = createDriver('dsh', { bin, cwd, storageDir, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('FIRST')
      await until(() => events.some(event => event.type === 'turn/end'))
    } finally { driver.dispose() }
    const savedId = events.find(event => event.state === 'ready').sessionId
    assert.match(savedId, /^dsh:isolated:/)
    const session = await host.api('session-create', { profile: role.id, lazy: true })
    assert.notEqual(session.id, role.id)
    const runtime = await host.runtime
    await runtime.prepareConversation(session.id)
    runtime.conversation(role.id, session.id).session.driverSessionId = savedId
    await runtime.save()
    await host.api('send', { profile: role.id, session: session.id, text: 'RESTORED' })
    await until(async () => !(await host.api('state')).work[session.id].active)
    const requests = readFileSync(join(cwd, 'dsh-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.ok(requests.some(request => request.method === 'session/resume'))
    const patch = JSON.parse(readFileSync(join(storageDir, 'dsh/sessions.patch.json'), 'utf8'))
    assert.equal(patch[0].config.root, join(storageDir, 'dsh/sessions'))
    assert.equal(runtime.conversation(role.id, session.id).session.driverSessionId, savedId)
    assert.ok((await host.api('transcript', { profile: role.id, session: session.id })).some(line => line.text === 'Hello world'))
  }))
})

test('DSH scan reads the host model directory, then falls back to ACP config options', async () => {
  const llm = {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'offline', name: 'Offline' }],
    listModels: provider => provider === 'offline' ? Promise.reject(new Error('catalog unavailable')) : [
      { provider, id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      { provider, id: 'deepseek-flash', name: 'Flash' },
    ],
    resolveModelInfo: (provider, model) => model === 'deepseek-flash'
      ? { provider, id: model, name: 'Flash' }
      : { provider, id: model, name: 'Pro', reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
  }
  const nativeHost = { get: name => name === 'llm' ? llm
    : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }) }
      : undefined }
  const catalog = await scanEngine('dsh', { nativeHost })
  assert.equal(catalog.source, 'DSH host model directory')
  assert.equal(catalog.defaultModel, '["deepseek-official","deepseek-v4-pro"]')
  assert.deepEqual(catalog.models.map(model => model.id), ['["deepseek-official","deepseek-v4-pro"]', '["deepseek-official","deepseek-flash"]'])
  assert.equal(catalog.models[0].label, 'DeepSeek-V4-Pro', 'the label is the model name, the provider stays in the id')
  assert.equal(catalog.models[0].group, 'DeepSeek', 'the provider is the section the model sits under')
  assert.deepEqual(catalog.models[0].thinking.map(level => level.id), ['off', 'high'])
  assert.equal(catalog.models[0].defaultThinking, 'high')
  assert.equal(catalog.models[1].thinking, undefined, 'a model without reasoning metadata offers no levels')

  // No host directory (a standalone CLI): the ACP session options answer, and the
  // scan session is closed again.
  await withFixture(async ({ bin, cwd }) => {
    const acp = await scanEngine('dsh', { engineOptions: { bin }, cwd })
    assert.equal(acp.source, 'DSH ACP session config options')
    assert.deepEqual(acp.models.map(model => model.id), ['["mock","model"]', '["mock","other"]'])
    assert.equal(acp.models[0].label, 'Mock')
    assert.equal(acp.models[0].group, 'Mock', 'the ACP model group names the section')
    assert.deepEqual(acp.models[0].thinking.map(level => level.id), ['medium', 'high'])
    assert.equal(acp.models[0].defaultThinking, 'high')
    assert.deepEqual(acp.models[1].thinking.map(level => level.id), ['low', 'high'])
    assert.equal(acp.models[1].defaultThinking, 'low', 'levels are read per selected model')
    assert.ok(readFileSync(join(cwd, 'session-ledger'), 'utf8').includes('session/close'))
  })
})

test('DSH replies, tool events, model choice and native resume round-trip', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    let driver = createDriver('dsh', { bin, cwd, model: 'Mock', onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('FIRST')
      await until(() => events.some(event => event.type === 'turn/end'))
      assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Hello world')
      assert.deepEqual(events.filter(event => event.type === 'thinking').map(event => event.text), ['private reasoning'])
      assert.deepEqual(events.filter(event => event.type === 'tool').map(event => [event.name, event.phase]), [['bash', 'start'], ['bash', 'end']])
      assert.deepEqual(events.find(event => event.type === 'turn/end').usage, { contextUsed: 10, contextSize: 100 })
      assert.equal(driver.hasSession(), true)
      const sessionId = events.find(event => event.sessionId).sessionId
      driver.dispose()
      events.length = 0
      driver = createDriver('dsh', { bin, cwd, driverSessionId: sessionId, onEvent: event => events.push(event) })
      await driver.sendTurn('WAIT')
      assert.equal(await driver.steer('change'), 'refused')
      await driver.interruptTurn()
      assert.equal(events.find(event => event.type === 'turn/end').reason, 'interrupted')
      assert.equal(events.filter(event => event.type === 'turn/end').length, 1)
      assert.equal(readFileSync(join(cwd, 'session-ledger'), 'utf8'), 'session/new\nmodel selected\nsession/resume\n')
      events.length = 0
      await driver.sendTurn('SECOND')
      await until(() => events.some(event => event.type === 'turn/end'))
      assert.equal(events.find(event => event.type === 'turn/end').reason, 'done')
    } finally { driver.dispose() }
  })
})

test('DSH permissions, queued messages and persistence work through the host', async () => {
  await withFixture(async ({ bin, cwd }) => withHost(async host => {
    const workspace = await host.api('workspace-create', { name: 'Fixture', cwd })
    const profile = await host.api('profile-create', { name: 'DeepSeek', engine: 'dsh', workspace: workspace.id, engineOptions: { bin, home: cwd } })
    for (const [decision, reply] of [['allow', 'Approved'], ['deny', 'Denied']]) {
      await host.api('send', { profile: profile.id, text: 'ASK_PERMISSION' })
      const card = await until(async () => (await host.api('state')).approvals[0])
      assert.equal(card.tool, 'bash')
      assert.equal((await host.api('send', { profile: profile.id, text: 'SECOND' })).mode, 'queued')
      await host.api('approval-answer', { id: card.id, decision })
      await until(async () => !(await host.api('state')).work[profile.id].active)
      const transcript = await host.api('transcript', { profile: profile.id })
      assert.ok(transcript.some(line => line.text === reply))
      assert.ok(transcript.some(line => line.text === 'Hello world'))
      assert.equal((await host.api('state')).approvals.length, 0)
    }
    await host.api('send', { profile: profile.id, text: 'ASK_PERMISSION' })
    await until(async () => (await host.api('state')).approvals[0])
    await host.api('interrupt', { profile: profile.id })
    assert.equal((await host.api('state')).approvals.length, 0)
    await host.api('send', { profile: profile.id, text: 'SECOND' })
    await until(async () => !(await host.api('state')).work[profile.id].active)
    host.dispose()
    const reopened = boot(host.home)
    try {
      assert.equal((await reopened.api('state')).profiles.find(item => item.id === profile.id).driverSessionId, 'fixture-dsh-session')
      await reopened.api('send', { profile: profile.id, text: 'AFTER_RESTART' })
      await until(async () => !(await reopened.api('state')).work[profile.id].active)
      assert.ok(readFileSync(join(cwd, 'session-ledger'), 'utf8').includes('session/resume'))
    } finally { reopened.dispose() }
  }))
})

test('standalone ACP preserves native ids and newer format errors without migrating data', async () => {
  await withFixture(async ({ cwd, bin }) => withHost(async host => {
    const workspace = await host.api('workspace-create', { name: 'Fixture', cwd })
    const profile = await host.api('profile-create', { name: 'Isolated', engine: 'dsh', workspace: workspace.id, engineOptions: { bin } })
    await host.api('send', { profile: profile.id, text: 'FIRST' })
    await until(async () => !(await host.api('state')).work[profile.id].active)
    assert.equal((await host.api('state')).profiles.find(item => item.id === profile.id).driverSessionId, 'fixture-dsh-session')
    await host.api('send', { profile: profile.id, text: 'SECOND' })
    await until(async () => !(await host.api('state')).work[profile.id].active)
    assert.equal((await host.api('transcript', { profile: profile.id })).filter(line => line.text === 'Hello world').length, 2)
    const legacy = createDriver('dsh', { bin, cwd, storageDir: host.home, driverSessionId: 'fixture-dsh-session', env: { DSH_FIXTURE_NEWER_FORMAT: '1' } })
    try {
      await assert.rejects(legacy.sendTurn('SECOND'), /DSH session\/resume failed.*format v4.*v3/)
      assert.throws(() => readFileSync(join(host.home, 'dsh/sessions.patch.json')), /ENOENT/)
      assert.equal(readFileSync(join(cwd, 'session-ledger'), 'utf8'), 'session/new\n')
    } finally { legacy.dispose() }
  }))
})

test('DSH startup cancellation, process death and output limit settle turns', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('dsh', { bin, cwd, env: { DSH_FIXTURE_SLOW_BOOT: '1' }, onEvent: event => events.push(event) })
    try {
      const starting = driver.sendTurn('WAIT')
      await driver.interruptTurn()
      assert.equal(events.filter(event => event.type === 'turn/end').length, 1)
      events.length = 0
      const next = driver.sendTurn('EXIT')
      await starting
      await next
      await until(() => events.some(event => event.type === 'turn/end'))
      assert.equal(events.find(event => event.type === 'turn/end').reason, 'error')
      events.length = 0
      await driver.sendTurn('LIMIT')
      await until(() => events.some(event => event.type === 'turn/end'))
      assert.equal(events.find(event => event.type === 'turn/end').reason, 'error')
      assert.match(events.find(event => event.type === 'turn/end').error, /max_tokens/)
    } finally { driver.dispose() }
  })
})

test('DSH discovers an existing npm CLI without replacing an explicit path', async () => {
  await withFixture(async ({ cwd, bin }) => {
    const root = join(cwd, '.npm/_npx/existing/node_modules')
    mkdirSync(join(root, '@deepseek-ai/dsh'), { recursive: true })
    mkdirSync(join(root, '.bin'), { recursive: true })
    writeFileSync(join(root, '@deepseek-ai/dsh/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
    const cached = join(root, '.bin/dsh')
    copyFileSync(bin, cached)
    chmodSync(cached, 0o755)
    assert.equal(findDshExecutable('dsh', { home: cwd, path: '', defaults: [] }), cached)
    assert.equal(findDshExecutable(bin, { home: cwd, path: '' }), bin)
    assert.equal(findDshExecutable(join(cwd, 'missing'), { home: cwd, path: '' }), undefined)
  })
})

test('DSH negotiates legacy resume and refuses to discard an unsupported saved session', async () => {
  await withFixture(async ({ cwd, bin }) => {
    writeFileSync(join(cwd, 'session-ledger'), '')
    const events = []
    const legacy = createDriver('dsh', { bin, cwd, driverSessionId: 'fixture-dsh-session', env: { DSH_FIXTURE_LEGACY: '1' }, onEvent: event => events.push(event) })
    try {
      await legacy.sendTurn('FIRST')
      await until(() => events.some(event => event.type === 'turn/end'))
      assert.equal(readFileSync(join(cwd, 'session-ledger'), 'utf8'), 'session/load\n')
    } finally { legacy.dispose() }
    const unsupported = createDriver('dsh', { bin, cwd, driverSessionId: 'fixture-dsh-session', env: { DSH_FIXTURE_NO_RESUME: '1' } })
    try {
      await assert.rejects(unsupported.sendTurn('FIRST'), /cannot restore/)
      assert.equal(readFileSync(join(cwd, 'session-ledger'), 'utf8'), 'session/load\n')
      assert.equal(unsupported.hasSession(), false)
    } finally { unsupported.dispose() }
    const badModel = createDriver('dsh', { bin, cwd, model: 'unknown' })
    try { await assert.rejects(badModel.sendTurn('FIRST'), /Model selector/); assert.equal(badModel.hasSession(), false) }
    finally { badModel.dispose() }
  })
})

test('DSH prompt may run longer than a transport handshake timeout', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const events = []
    const driver = createDriver('dsh', { bin, cwd, onEvent: event => events.push(event) })
    try {
      await driver.sendTurn('LONG')
      const end = await until(() => events.find(event => event.type === 'turn/end'), 20000)
      assert.equal(end.reason, 'done')
      assert.equal(events.find(event => event.type === 'delta').text, 'Long reply')
    } finally { driver.dispose() }
  })
})

test('standalone DSH ignores lead MCP server options it does not consume', async () => {
  await withFixture(async ({ bin, cwd }) => {
    const servers = [{ name: 'nodo_role', command: process.execPath, args: [], env: [] }]
    for (const leadMcpServers of [undefined, servers]) {
      const driver = createDriver('dsh', { bin, cwd, leadMcpServers })
      driver.dispose()
    }
  })
})
