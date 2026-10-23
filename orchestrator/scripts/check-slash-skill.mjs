#!/usr/bin/env node
// Opt-in live probe: does the engine's channel interpret a slash line as a
// skill/command, or does it reach the model as literal text?
//   node scripts/check-slash-skill.mjs [engine ...]   default: zcode codex opencode claude dsh
// Plants a throwaway `nodo-probe` skill instructing one exact reply token,
// sends `/nodo-probe` as a turn, and compares the answer. Files are removed
// afterwards; claude's copy is planted inside the throwaway workspace only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDriver } from '../agent-drivers/dist/index.js'

const TOKEN = 'NODO_PROBE_OK'
const SKILL_BODY = `Reply with the exact token ${TOKEN} and nothing else.`

// Engines that read skills from the workspace itself get the plant there, so
// the probe never writes into a real home directory (dsh's DSH_HOME included —
// its storage is also redirected into the workspace via the driver's patch).
const WORKSPACE_PLANTS = {
  claude: workspace => join(workspace, '.claude', 'skills', 'nodo-probe'),
  dsh: workspace => join(workspace, '.dsh', 'skills', 'nodo-probe'),
}

const HOME_PLANTS = {
  zcode: () => [join(homedir(), '.agents', 'skills', 'nodo-probe')],
  codex: () => [join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'prompts')],
  opencode: () => [join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode', 'command')],
}

const until = async (ready, ms) => {
  const deadline = Date.now() + ms
  for (;;) {
    const value = ready()
    if (value) return value
    if (Date.now() > deadline) throw new Error('probe timeout')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

const textOf = events => events.filter(event => event.type === 'text' || event.type === 'delta').map(event => event.text).join('')

async function probe(engine) {
  const workspace = mkdtempSync(join(tmpdir(), `orch-slash-${engine}-`))
  const planted = []
  const plant = WORKSPACE_PLANTS[engine]
  if (plant) {
    const dir = plant(workspace)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: nodo-probe\ndescription: probe\n---\n${SKILL_BODY}\n`)
  } else {
    for (const base of HOME_PLANTS[engine]()) {
      mkdirSync(base, { recursive: true })
      const file = engine === 'zcode' ? join(base, 'SKILL.md') : join(base, 'nodo-probe.md')
      writeFileSync(file, (engine === 'codex' ? '' : `---\nname: nodo-probe\ndescription: probe\n---\n`) + `${SKILL_BODY}\n`)
      planted.push(base)
    }
  }
  const events = []
  // zcode's account (subscription) provider is fail-closed to externally
  // spawned app-servers, so the probe pins the personal custom provider.
  // opencode keeps its own default: its free Go models may hit the workspace
  // privacy gate, in which case the probe reports that upstream error as-is.
  const pinned = { zcode: process.env.ZCODE_PROBE_MODEL ?? 'bigmodel-api$GLM-5.3-Flash' }
  const model = pinned[engine]
  const driver = createDriver(engine, {
    cwd: workspace,
    ...(model ? { model } : {}),
    ...(engine === 'dsh' ? { storageDir: join(workspace, 'storage') } : {}),
    onEvent: event => events.push(event),
  })
  try {
    await driver.sendTurn('/nodo-probe')
    await until(() => events.find(event => event.type === 'turn/end'), 240000)
    const text = textOf(events)
    const end = events.find(event => event.type === 'turn/end')
    const shapes = events.map(event => event.type).join(',')
    return { engine, ok: text.includes(TOKEN), evidence: (text.slice(0, 240).replace(/\s+/g, ' ') || '(no text)') + (text.includes(TOKEN) ? '' : ` — end=${end.reason}${end.error ? ` ${JSON.stringify(end.error).slice(0, 160)}` : ''} events=[${shapes}]`) }
  } finally {
    driver.dispose()
    for (const base of planted) rmSync(base, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
}

const engines = process.argv.slice(2)
const list = engines.length > 0 ? engines : ['zcode', 'codex', 'opencode', 'claude', 'dsh']
let failed = 0
for (const engine of list) {
  process.stdout.write(`probing ${engine} ... `)
  try {
    const result = await probe(engine)
    console.log(result.ok ? `INTERPRETED — reply: ${result.evidence}` : `NOT interpreted — reply: ${result.evidence}`)
    if (!result.ok) failed += 1
  } catch (error) {
    failed += 1
    console.log(`ERROR — ${error.message}`)
  }
}
process.exitCode = failed > 0 ? 1 : 0
