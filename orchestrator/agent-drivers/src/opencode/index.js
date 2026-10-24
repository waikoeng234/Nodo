import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createAcpDriver, initializeAcp } from '../acp/core.js'
import { acpModelCatalog } from '../acp/catalog.js'
import { formElicitation } from '../acp/elicitation.js'
import { jsonRpcProcess } from '../json-rpc-process.js'
import { cliVersion, findExecutable, invalidConfig, validateBin, validateWorkspace } from '../cli.js'
import { collector, COMMAND_NAME } from '../skills.js'
import { opencodeInstructions } from './instructions.js'

export { findExecutable } from '../cli.js'

export const opencodeInfo = {
  id: 'opencode', label: 'OpenCode CLI', command: 'opencode', requiresCwd: true,
  description: 'Uses the local OpenCode CLI and its existing login; sessions are shared with OpenCode.',
  fields: [
    { name: 'bin', target: 'engineOptions', label: 'CLI executable (optional)', type: 'text', placeholder: 'Auto-detect opencode; or enter an absolute path' },
    { name: 'model', target: 'profile', label: 'Model (optional)', type: 'text', placeholder: 'provider/model; blank uses OpenCode settings' },
  ],
  capabilities: { resume: true, steer: false, permissions: true, questions: true, commands: true, permissionModes: ['plan', 'workspace'] },
}

export function validateOpencodeOptions(raw = {}) {
  for (const key of Object.keys(raw)) if (key !== 'bin') throw invalidConfig(`Unsupported OpenCode option: ${key}`)
  const bin = validateBin(raw.bin)
  return bin ? { bin } : {}
}

export async function checkOpencode({ cwd, engineOptions = {} } = {}) {
  const checks = []
  try { validateWorkspace(cwd, true); checks.push({ label: 'Working directory', ok: true, message: cwd }) }
  catch (error) { checks.push({ label: 'Working directory', ok: false, message: error.message }) }
  const options = validateOpencodeOptions(engineOptions)
  const executable = findExecutable(options.bin ?? 'opencode')
  if (!executable) return { engine: 'opencode', ok: false, checks: [...checks, { label: 'CLI', ok: false, message: 'OpenCode executable not found. Install OpenCode or enter its absolute path.' }] }
  let version
  try { version = await cliVersion(executable); checks.push({ label: 'CLI', ok: true, message: `${version} · ${executable}` }) }
  catch { return { engine: 'opencode', ok: false, executable, checks: [...checks, { label: 'CLI', ok: false, message: 'CLI version check failed or timed out.' }] } }
  let peer
  try {
    peer = await handshakeOpencode({ executable, cwd })
    checks.push({ label: 'Protocol', ok: true, message: 'OpenCode ACP server connected' })
    checks.push({ label: 'Model / credentials', ok: null, message: 'The protocol has no credential query. The existing OpenCode login is used; a conversation is needed to verify the model route.' })
  } catch (error) {
    checks.push({ label: 'Protocol', ok: false, message: `Could not reach the OpenCode ACP server (${error.message}). Verify the installation; the first start may take a moment.` })
  } finally { peer?.dispose() }
  return { engine: 'opencode', ok: checks.every(check => check.ok !== false), executable, version, checks }
}

// Spawn the ACP server once and prove the initialize handshake round-trips.
async function handshakeOpencode({ executable, cwd }) {
  const peer = jsonRpcProcess({ bin: executable, args: ['acp'], cwd, jsonrpc: '2.0', onRequest: ({ id }) => peer.refuse(id) })
  try { await initializeAcp(peer); return peer }
  catch (error) { peer.dispose(); throw error }
}

// Model discovery through a throwaway session: config options carry the whole
// model catalog, and selecting each candidate makes the reply carry the effort
// levels recomputed for that model.
export async function scanOpencode({ engineOptions = {}, cwd } = {}) {
  const options = validateOpencodeOptions(engineOptions)
  const executable = findExecutable(options.bin ?? 'opencode')
  if (!executable) return { source: 'OpenCode CLI not found', models: [] }
  let peer
  try {
    peer = await handshakeOpencode({ executable, cwd: cwd ?? process.cwd() })
    const session = await peer.request('session/new', { cwd: cwd ?? process.cwd(), mcpServers: [] }, 30_000)
    const modelOption = (session?.configOptions ?? []).find(item => item?.id === 'model')
    const models = await acpModelCatalog({ peer, sessionId: session.sessionId, configOptions: session?.configOptions, effortConfigId: 'effort' })
    return { source: 'OpenCode session config', ...(modelOption?.currentValue ? { defaultModel: String(modelOption.currentValue) } : {}), models }
  } catch {
    return { source: 'OpenCode scan failed', models: [] }
  } finally { peer?.dispose() }
}

// The ACP channel hands prompt text to the model verbatim and swallows a
// leading slash silently — the CLI expands commands only in its own TUI. The
// driver therefore resolves /name from the same files and id rule the scan
// lists (project winning) and sends the body; a first word outside that rule
// is text, an unknown command name errors instead of vanishing.
const opencodeConfigDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')

// The roots the CLI itself resolves, in order: the project's .opencode and the
// compatibility trees it also loads (.claude, .agents), then the global config
// directory. Command roots hold flat markdown files; skill roots hold one
// directory per skill or a flat markdown skill, symlinks followed.
const opencodeRoots = cwd => [
  { dir: join(cwd ?? '.', '.opencode', 'command'), skills: false, scope: 'project' },
  { dir: join(cwd ?? '.', '.opencode', 'commands'), skills: false, scope: 'project' },
  { dir: join(cwd ?? '.', '.opencode', 'skill'), skills: true, scope: 'project' },
  { dir: join(cwd ?? '.', '.opencode', 'skills'), skills: true, scope: 'project' },
  { dir: join(cwd ?? '.', '.claude', 'skills'), skills: true, scope: 'project' },
  { dir: join(cwd ?? '.', '.agents', 'skills'), skills: true, scope: 'project' },
  { dir: join(opencodeConfigDir(), 'command'), skills: false, scope: 'global' },
  { dir: join(opencodeConfigDir(), 'commands'), skills: false, scope: 'global' },
  { dir: join(opencodeConfigDir(), 'skill'), skills: true, scope: 'global' },
  { dir: join(opencodeConfigDir(), 'skills'), skills: true, scope: 'global' },
  { dir: join(homedir(), '.claude', 'skills'), skills: true, scope: 'global' },
  { dir: join(homedir(), '.agents', 'skills'), skills: true, scope: 'global' },
]

const opencodeScan = (cwd) => {
  const found = collector()
  for (const root of opencodeRoots(cwd)) {
    let entries
    try { entries = readdirSync(root.dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const path = join(root.dir, entry.name)
      let info
      try { info = statSync(path) } catch { continue }
      if (root.skills && info.isDirectory()) found.add(join(path, 'SKILL.md'), entry.name, undefined, root.scope)
      else if (info.isFile() && entry.name.endsWith('.md')) found.add(path, entry.name.replace(/\.md$/, ''), undefined, root.scope)
    }
  }
  return found
}

const opencodeCommandBody = (name, cwd) => {
  const entry = opencodeScan(cwd).list().commands.find(command => command.id === name)
  if (entry === undefined) return undefined
  return readFileSync(entry.path, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
}

export function createOpencodeDriver({ bin = 'opencode', cwd, env = {}, model, thinking, instructions, instructionDir, identityFiles, identityOwner, ...options } = {}) {
  const identity = opencodeInstructions(instructions, env, instructionDir, identityFiles, identityOwner)
  return createAcpDriver({ ...options, cwd }, {
    id: 'opencode', label: 'OpenCode', resumeMethod: 'load', fileChanges: true,
    get instructionMode() { return identity.mode },
    dispose: () => identity.dispose(),
    async expandPrompt(text) {
      const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
      if (!match || !COMMAND_NAME.test(match[1])) return text
      const body = opencodeCommandBody(match[1], cwd)
      if (body === undefined) throw invalidConfig(`OpenCode has no command or skill "/${match[1]}"`)
      return match[2] ? `${body}\n\n${match[2]}` : body
    },
    connect(callbacks) {
      const executable = findExecutable(bin)
      if (!executable) throw new Error('OpenCode executable not found. Install OpenCode or edit the profile CLI path.')
      return jsonRpcProcess({ bin: executable, args: ['acp'], cwd, env: identity.env, jsonrpc: '2.0', ...callbacks })
    },
    initialize: peer => initializeAcp(peer, { elicitation: { form: {} } }),
    question: formElicitation,
    async configure({ peer, sessionId, attached, permission }) {
      let configOptions = attached.configOptions
      const current = id => (configOptions ?? []).find(item => item?.id === id)?.currentValue
      // The autonomy tier is opencode's own session mode; the engine offers no
      // full-auto tier, so the capability list honestly stops at workspace.
      const mode = permission === 'plan' ? 'plan' : 'build'
      if (current('mode') !== mode) {
        const result = await peer.request('session/set_config_option', { sessionId, configId: 'mode', value: mode })
        configOptions = result.configOptions ?? configOptions
      }
      if (model && current('model') !== model) {
        const result = await peer.request('session/set_config_option', { sessionId, configId: 'model', value: model })
        configOptions = result.configOptions ?? configOptions
      }
      if (thinking && current('effort') !== thinking) await peer.request('session/set_config_option', { sessionId, configId: 'effort', value: thinking })
    },
  })
}

// The composer's /-menu inventory: the command markdown and skill files the
// CLI resolves, from the project's .opencode and compatibility trees (winning
// on name collisions) and the user's global config directory.
export async function scanOpencodeCommands({ engineOptions = {}, cwd } = {}) {
  validateOpencodeOptions(engineOptions)
  return opencodeScan(cwd).list('OpenCode commands and skills')
}
