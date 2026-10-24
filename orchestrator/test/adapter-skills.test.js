import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scanEngineCommands } from '../agent-drivers/dist/index.js'
import { apply } from '../src/host/adapter/skills.js'

const catalog = (engine, commands) => {
  let service
  apply({ nodoAdapter: { commands }, provide: (name, value) => { assert.equal(name, 'skills'); service = value } }, { engine })
  return service
}

test('native role skill catalogs reuse each engine scan and preserve invocation names', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nodo-adapter-skills-'))
  const previous = Object.fromEntries(['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME'].map(key => [key, process.env[key]]))
  const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
  try {
    process.env.HOME = home
    process.env.CODEX_HOME = join(home, '.codex')
    process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
    process.env.XDG_CONFIG_HOME = join(home, '.config')
    const cwd = join(home, 'project')
    mkdirSync(cwd)
    write(join(home, '.codex/plugins/cache/official/demo/1.0/skills/codex-only/SKILL.md'), '---\nname: codex-only\ndescription: Codex skill\n---\nbody')
    write(join(home, '.claude/plugins/marketplaces/official/plugins/documents/skills/docx/SKILL.md'), '---\nname: docx\ndescription: Claude documents\n---\nbody')
    write(join(cwd, '.claude/commands/project_review.md'), '---\ndescription: Review this project\n---\nbody')
    write(join(home, '.agents/skills/zcode-only/SKILL.md'), '---\nname: zcode-only\ndescription: ZCode skill\n---\nbody')
    write(join(cwd, '.opencode/command/local.md'), '---\ndescription: Local command\n---\nbody')
    for (const [engine, expected] of Object.entries({
      codex: ['codex-only'], claude: ['documents:docx', 'project_review'], zcode: ['zcode-only'], opencode: ['local', 'zcode-only'],
    })) {
      const service = catalog(engine, ({ engine, cwd }) => scanEngineCommands(engine, { cwd }))
      const skills = await service.list({ cwd })
      assert.deepEqual(skills.map(skill => skill.name).sort(), expected, engine)
      assert.ok(skills.every(skill => skill.path && skill.description && skill.provider === `nodo:${engine}` && skill.invocation.userInvocable))
      assert.deepEqual(await service.snapshot({ cwd }), { skills, complete: true })
    }
    const service = catalog('claude', ({ engine, cwd }) => scanEngineCommands(engine, { cwd }))
    assert.deepEqual((await service.list({ cwd: home })).map(skill => skill.name), ['documents:docx'], 'project commands follow the native session cwd')
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
})

test('empty scans stay empty, discovery failures propagate, and cancelled lookups stop', async () => {
  const service = catalog('codex', async () => ({ source: 'Codex', commands: [] }))
  assert.deepEqual(await service.list(), [])
  assert.equal(await service.get('docx'), undefined, 'the host must not load a skill on behalf of the engine')
  await assert.rejects(catalog('codex', async () => { throw new Error('scan failed') }).list(), /scan failed/)
  const abort = new AbortController()
  abort.abort(new Error('cancelled'))
  await assert.rejects(service.list({ signal: abort.signal }), /cancelled/)
  const duringScan = new AbortController()
  await assert.rejects(catalog('codex', async () => { duringScan.abort(new Error('cancelled during scan')); return { commands: [] } }).list({ signal: duringScan.signal }), /cancelled during scan/)
})
