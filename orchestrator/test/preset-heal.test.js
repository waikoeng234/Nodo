import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { test } from 'node:test'
import { SESSION_LOG, findOrphanedPresets, healPreset, listSessionLogs, readSessionHeader } from '../src/host/adapter/preset-heal.js'

// A native session log as the host writes it: one zstd frame whose first line is
// the session header, the only line that names the agent preset.
const sessionLog = (dir, sessionId, agentPreset, extra = '') => {
  const folder = join(dir, sessionId)
  mkdirSync(folder, { recursive: true })
  const path = join(folder, SESSION_LOG)
  writeFileSync(path, zstdCompressSync(`${JSON.stringify({ type: 'session', version: 4, id: sessionId, cwd: '/tmp/heal', agentPreset })}\n${extra}`))
  return path
}

const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'nodo-preset-heal-'))
  mkdirSync(join(root, 'bot'), { recursive: true })
  return root
}

test('session headers are read from every workspace directory, and a non-session file is ignored', async () => {
  const root = workspace()
  try {
    const path = sessionLog(join(root, 'bot'), 'session-1', 'nodo:codex:role')
    writeFileSync(join(root, 'bot', 'notes.txt'), 'not a session')
    const logs = await listSessionLogs(root)
    assert.deepEqual(logs, [path])
    assert.deepEqual(await readSessionHeader(path), { type: 'session', version: 4, id: 'session-1', cwd: '/tmp/heal', agentPreset: 'nodo:codex:role' })
    assert.equal(await readSessionHeader(join(root, 'missing', 'session.v4.jsonl.zstd')), undefined)
    assert.equal((await listSessionLogs(join(root, 'missing'))).length, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('only dangling Nodo presets are collected, grouped by the sessions that carry them', async () => {
  const root = workspace()
  try {
    sessionLog(join(root, 'bot'), 'session-1', 'nodo:codex:gone')
    sessionLog(join(root, 'bot'), 'session-2', 'nodo:codex:gone')
    sessionLog(join(root, 'bot'), 'session-3', 'standard')
    sessionLog(join(root, 'bot'), 'session-4', 'nodo:zcode:live')
    mkdirSync(join(root, 'bot', 'broken'), { recursive: true })
    writeFileSync(join(root, 'bot', 'broken', SESSION_LOG), 'not zstd')
    const known = new Set(['nodo:zcode:live'])
    const orphans = await findOrphanedPresets({ listing: () => listSessionLogs(root), isRegistered: async id => known.has(id) })
    assert.deepEqual(orphans, [{ id: 'nodo:codex:gone', sessions: ['session-1', 'session-2'] }],
      'the host presets and still-registered roles must stay untouched')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('healing rewrites orphaned sessions onto the fallback and drops the rescue definition again', async () => {
  const registered = []
  const disposed = []
  const healed = []
  const agents = new Map([['session-1', { id: 'session-1' }], ['session-2', { id: 'session-2' }]])
  const agentPresets = {
    register: async ({ id, name, description, plugins }) => { registered.push({ id, name, description, plugins }); return async () => { disposed.push(id) } },
    select: async (agent, preset) => { healed.push([agent.id, preset]); return preset },
  }
  const sessionController = { resolveAgent: async id => agents.has(id) ? { agent: agents.get(id) } : { error: new Error('resume failed') } }
  const result = await healPreset({ id: 'nodo:codex:gone', sessions: ['session-1', 'session-2', 'gone-session'], fallback: 'standard',
    agentPresets, sessionController, warn: () => {} })
  assert.deepEqual(result, { healed: 2, refused: 1 })
  assert.deepEqual(registered, [{ id: 'nodo:codex:gone', name: 'nodo:codex:gone', description: 'Deleted Nodo role: history only', plugins: [] }],
    'the rescue definition must claim the id without mounting a preset of its own')
  assert.deepEqual(healed, [['session-1', 'standard'], ['session-2', 'standard']])
  assert.deepEqual(disposed, ['nodo:codex:gone'], 'the dangling id must not stay registered')
})

test('a session whose first turn already ran keeps its preset and is reported, never forced', async () => {
  const warns = []
  const disposed = []
  const agent = { id: 'session-1' }
  const result = await healPreset({ id: 'nodo:codex:gone', sessions: ['session-1'], fallback: 'standard', warn: (template, ...args) => warns.push([template, ...args]),
    agentPresets: {
      register: async () => async () => { disposed.push('nodo:codex:gone') },
      select: async () => { throw Object.assign(new Error('This session has already started'), { code: 'agent-preset/locked' }) },
    },
    sessionController: { resolveAgent: async () => ({ agent }) } })
  assert.deepEqual(result, { healed: 0, refused: 1 })
  assert.deepEqual(disposed, ['nodo:codex:gone'])
  assert.deepEqual(warns, [['nodo: kept %d of %d native session(s) on the deleted role preset "%s" until their next cold resume: %s', 1, 1, 'nodo:codex:gone', 'This session has already started']])
})

test('a host that cannot register the rescue definition heals nothing and keeps the failure visible', async () => {
  const warns = []
  const result = await healPreset({ id: 'nodo:codex:gone', sessions: ['session-1'], fallback: 'standard', warn: (template, ...args) => warns.push([template, ...args]),
    agentPresets: { register: async () => { throw new Error('Duplicate agent preset: nodo:codex:gone') } },
    sessionController: { resolveAgent: async () => ({ agent: { id: 'session-1' } }) } })
  assert.deepEqual(result, { healed: 0, refused: 1, failed: true })
  assert.deepEqual(warns, [['nodo: cannot heal native sessions on the deleted role preset "%s": %s', 'nodo:codex:gone', 'Duplicate agent preset: nodo:codex:gone']])
})
