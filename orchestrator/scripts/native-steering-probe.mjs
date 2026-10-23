import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

export async function checkNativeSteering({ api, nativeCall, observe, until, home }) {
  const specs = [
    { engine: 'codex', fixture: 'codex-cli.cjs', model: 'fixture-model', initial: 'WAIT', result: 'Steered', marker: '"method":"turn/start"' },
    { engine: 'claude', fixture: 'claude-cli.cjs', model: 'sonnet', initial: 'WAIT', result: 'Steered native followup', marker: '"user":"WAIT"',
      env: { CLAUDE_FIXTURE_STEERING: '1', CLAUDE_FIXTURE_WAIT_MS: '3000' } },
    { engine: 'zcode', fixture: 'zcode-cli.cjs', model: 'mock$glm-test', initial: 'WAIT', result: 'Steered native followup', log: 'zcode-turns.jsonl', marker: 'WAIT', env: { FIXTURE_V4_GUIDE: '1' } },
    { engine: 'opencode', fixture: 'opencode-adapter-cli.cjs', model: 'fixture/fixture-model', initial: 'HANG', marker: '"text":"HANG"', queued: true, env: { CODEX_FIXTURE_HANG_MS: '800' } },
  ]
  for (const spec of specs) {
    const cwd = mkdirSync(join(home, `steering-${spec.engine}`), { recursive: true })
    const bin = join(home, `steering-${spec.engine}.cjs`)
    const fixture = fileURLToPath(new URL(`../test/fixtures/${spec.fixture}`, import.meta.url))
    writeFileSync(bin, `#!/usr/bin/env node\nObject.assign(process.env, ${JSON.stringify(spec.env ?? {})}); require(${JSON.stringify(fixture)});\n`)
    chmodSync(bin, 0o755)
    await api('engine-config-set', { engine: spec.engine, engineOptions: { bin } })
    await api('engine-scan', { engine: spec.engine })
    const workspace = await api('workspace-create', { name: spec.engine, cwd })
    const role = await api('profile-create', { name: `Steering ${spec.engine}`, engine: spec.engine, workspace: workspace.id, model: spec.model })
    const opened = await api('adapter-session-open', { profile: role.id, workspace: workspace.id })
    const observation = await observe(opened.sessionId)
    try {
      const prompt = (text, mode) => nativeCall('session/prompt', { request: { requestId: randomUUID(), sessionId: opened.sessionId, mode, content: [{ type: 'text', text }] } })
      await prompt(spec.initial, 'queue')
      const logfile = join(cwd, spec.log ?? `${spec.engine}-requests.jsonl`)
      await until(() => { try { return readFileSync(logfile, 'utf8').includes(spec.marker) } catch { return false } })
      await prompt('native followup', 'steer')
      await until(async () => !(await api('state')).work[opened.conversationId]?.active)
      const events = observation.frames.filter(item => item?.type === 'event').map(item => item.event)
      assert.equal(events.filter(event => event.type === 'turn/end' && event.data.reason?.kind !== 'completed').length, 0, `${spec.engine} native turn failed`)
      if (spec.queued) {
        const rows = readFileSync(logfile, 'utf8').trim().split('\n').map(JSON.parse)
        assert.equal(rows.filter(row => row.method === 'session/prompt' && row.text === 'native followup').length, 1)
        assert.equal(events.filter(event => event.type === 'turn/start').length, 2)
      } else {
        assert.ok(events.some(event => event.type === 'assistant/message' && JSON.stringify(event.data.message).includes(spec.result)), `${spec.engine} followup was not answered`)
        assert.equal(events.filter(event => event.type === 'turn/start').length, 1)
      }
      console.log(`${spec.engine}: native host ${spec.queued ? 'queue fallback' : 'steering'} passed (fixture engine)`)
    } finally { observation.close() }
  }
}
