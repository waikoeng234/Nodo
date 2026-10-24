import { createAcpDriver, initializeAcp } from '../acp/core.js'
import { acpModelCatalog } from '../acp/catalog.js'
import { formElicitation } from '../acp/elicitation.js'
import { jsonRpcProcess } from '../json-rpc-process.js'
import { UnsupportedCapabilityError } from '../spi.js'
import { cliVersion, findExecutable, invalidConfig, validateBin, validateWorkspace } from '../cli.js'
import type { AcpAttached, AcpDriverOptions, AcpParams, AcpSupport } from '../acp/core.js'
import type { AcpConfigOption } from '../acp/catalog.js'
import type { EngineInfo } from '../spi.js'
import type { EngineScanOptions, ModelCatalog } from '../index.js'
import type { JsonRpcPeer } from '../json-rpc-process.js'

export type CodebuddyOptions = { bin?: string }
export type CodebuddyDriverOptions = AcpDriverOptions & {
  bin?: string; env?: NodeJS.ProcessEnv; model?: string; thinking?: string; instructions?: string
}
export type CodebuddyCheckResult = {
  engine: 'codebuddy'; ok: boolean; executable?: string; version?: string
  checks: { label: string; ok: boolean | null; message?: string }[]
}
type CodebuddyQuestionInput = {
  questions?: { question?: unknown; multiSelect?: unknown; options?: { label?: unknown; description?: unknown }[] }[]
}

export { findExecutable } from '../cli.js'

export const codebuddyInfo = {
  id: 'codebuddy', label: 'CodeBuddy', command: 'codebuddy', requiresCwd: true,
  description: 'Uses the local CodeBuddy CLI and its existing login; sessions live in the CLI\'s own storage.',
  fields: [
    { name: 'bin', target: 'engineOptions', label: 'CLI executable (optional)', type: 'text', placeholder: 'Auto-detect codebuddy; or enter an absolute path' },
    { name: 'model', target: 'profile', label: 'Model (optional)', type: 'text', placeholder: 'e.g. deepseek-v4.1-flash; blank uses Auto' },
  ],
  capabilities: { resume: true, steer: false, permissions: true, questions: true, permissionModes: ['plan', 'workspace', 'full'] },
} satisfies EngineInfo

export function validateCodebuddyOptions(raw: Record<string, unknown> = {}): CodebuddyOptions {
  for (const key of Object.keys(raw)) if (key !== 'bin') throw invalidConfig(`Unsupported CodeBuddy option: ${key}`)
  const bin = validateBin(raw.bin)
  return bin ? { bin } : {}
}

// The AskUserQuestion tool only reaches the model when the handshake declares
// the private question capability; the engine has no other elicitation trigger.
const clientCapabilities = { elicitation: { form: {} }, _meta: { 'codebuddy.ai': { question: true } } }
const backgroundLimit = 'Nodo does not support CodeBuddy Multitask or cross-turn worker questions. Use a session without active background workers and reopen it in Nodo.'
const hasMultitask = (options: unknown) => Array.isArray(options) && options.some((option: AcpConfigOption) => ['multitask', '_codebuddy.ai/multitask'].includes(option?.id!) && option.currentValue === true)

// Spawn the ACP server once and prove the initialize handshake round-trips.
async function handshakeCodebuddy({ executable, cwd }: { executable: string; cwd?: string }): Promise<JsonRpcPeer> {
  const peer = jsonRpcProcess({ bin: executable, args: ['--acp'], cwd, jsonrpc: '2.0', onRequest: message => peer.refuse(message.id) })
  try { await initializeAcp(peer, clientCapabilities); return peer }
  catch (error) { peer.dispose(); throw error }
}

export async function checkCodebuddy({ cwd, engineOptions = {} }: EngineScanOptions = {}): Promise<CodebuddyCheckResult> {
  const checks: CodebuddyCheckResult['checks'] = []
  try { validateWorkspace(cwd, true); checks.push({ label: 'Working directory', ok: true, message: cwd }) }
  catch (error) { checks.push({ label: 'Working directory', ok: false, message: (error as Error).message }) }
  const options = validateCodebuddyOptions(engineOptions)
  const executable = findExecutable(options.bin ?? 'codebuddy')
  if (!executable) return { engine: 'codebuddy', ok: false, checks: [...checks, { label: 'CLI', ok: false, message: 'CodeBuddy executable not found. Install CodeBuddy or enter its absolute path.' }] }
  let version
  try { version = await cliVersion(executable); checks.push({ label: 'CLI', ok: true, message: `${version} · ${executable}` }) }
  catch { return { engine: 'codebuddy', ok: false, executable, checks: [...checks, { label: 'CLI', ok: false, message: 'CLI version check failed or timed out.' }] } }
  let peer: JsonRpcPeer | undefined
  try {
    peer = await handshakeCodebuddy({ executable, cwd })
    checks.push({ label: 'Protocol', ok: true, message: 'CodeBuddy ACP server connected' })
    checks.push({ label: 'Model / credentials', ok: null, message: 'The handshake needs no login; run the CLI once to log in first. A conversation is needed to verify the model route.' })
  } catch (error) {
    checks.push({ label: 'Protocol', ok: false, message: `Could not reach the CodeBuddy ACP server (${(error as Error).message}). Verify the installation.` })
  } finally { peer?.dispose() }
  return { engine: 'codebuddy', ok: checks.every(check => check.ok !== false), executable, version, checks }
}

// Model discovery through a throwaway session: the model option carries the
// account's catalog, and selecting each candidate recomputes the thought levels
// for that model.
export async function scanCodebuddy({ engineOptions = {}, cwd }: EngineScanOptions = {}): Promise<Omit<ModelCatalog, 'engine'>> {
  const options = validateCodebuddyOptions(engineOptions)
  const executable = findExecutable(options.bin ?? 'codebuddy')
  if (!executable) return { source: 'CodeBuddy CLI not found', models: [] }
  try {
    const peer = await handshakeCodebuddy({ executable, cwd: cwd ?? process.cwd() })
    try {
      const session = await peer.request<AcpAttached>('session/new', { cwd: cwd ?? process.cwd(), mcpServers: [] }, 30_000)
      const modelOption = (session?.configOptions ?? []).find(item => item?.id === 'model')
      const models = await acpModelCatalog({ peer, sessionId: session.sessionId!, configOptions: session?.configOptions, modelConfigId: 'model', effortConfigId: 'thought_level' })
      return { source: 'CodeBuddy session config', ...(modelOption?.currentValue ? { defaultModel: String(modelOption.currentValue) } : {}), models }
    } finally { peer.dispose() }
  } catch {
    return { source: 'CodeBuddy scan failed', models: [] }
  }
}

// A CodeBuddy question is a permission request gating the AskUserQuestion tool
// call, whose raw input carries the questions. The ACP reply only opens the
// gate — the answers travel back through the private resolveInterruption
// request, and without them the turn hangs. A resolved tool name that is not
// the ask tool (any ordinary tool may take a `questions` input) stays a
// permission; an unresolvable name promotes, since the gate can precede the
// streamed call only in an ordering race.
const askQuestions: AcpSupport['question'] = ({ method, params, tool }) => {
  if (method !== 'session/request_permission') return formElicitation({ method, params })
  if (tool !== undefined && !/askuserquestion/i.test(tool.replace(/[\s_-]/g, ''))) return undefined
  const raw = Array.isArray((params.toolCall?.rawInput as CodebuddyQuestionInput | undefined)?.questions) ? (params.toolCall!.rawInput as CodebuddyQuestionInput).questions! : []
  const questions = raw.flatMap((item, index) => {
    const text = typeof item?.question === 'string' ? item.question.trim() : ''
    if (text === '') return []
    return [{ id: `q_${index}`, question: text, ...(item?.multiSelect === true ? { multiSelect: true } : {}),
      options: (Array.isArray(item?.options) ? item.options : []).flatMap(option => {
        const label = typeof option?.label === 'string' ? option.label.trim() : ''
        return label === '' ? [] : [{ label, ...(typeof option?.description === 'string' && option.description.trim() !== '' ? { description: option.description.trim() } : {}) }]
      }) }]
  })
  if (questions.length === 0) return undefined
  const answersOf = (value?: string) => {
    let values: unknown
    if (questions.length === 1) values = { [questions[0].id]: String(value ?? '').trim() }
    else {
      try { values = JSON.parse(value!) } catch { throw new Error('Answer each question using the form') }
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Answer each question using the form')
    }
    if (questions.some(question => String((values as Record<string, unknown>)?.[question.id] ?? '').trim() === '')) throw new Error('Answer every question first')
    return Object.fromEntries(questions.map(question => {
      const value = (values as Record<string, unknown>)[question.id]
      return [question.id, Array.isArray(value) ? value.map((item: unknown) => String(item).trim()).filter(Boolean) : String(value).trim()]
    }))
  }
  return {
    card: { reason: params.toolCall?.title ?? questions.map(question => question.question).join('\n'), detail: { questions } },
    // The shared core opens the ACP gate; this hook only carries the answers
    // through the private interruption channel. Awaited so a failed
    // resolution throws through respondToRequest and the card survives for a
    // retry instead of closing onto a hanging turn.
    async respond({ peer, sessionId, value }) {
      const answers = answersOf(value)
      const result = await peer.request<{ resolved?: unknown }>('_codebuddy.ai/resolveInterruption', { sessionId, toolCallId: params.toolCall?.toolCallId, decision: 'allow', answers })
      if (result?.resolved !== true) throw new Error('CodeBuddy did not confirm this answer; the question may have expired. Retry or stop the turn.')
    },
  }
}

export function createCodebuddyDriver({ bin = 'codebuddy', cwd, env = {}, model, thinking, instructions, ...options }: CodebuddyDriverOptions = {}) {
  let nativeSessionId = options.driverSessionId
  let backgroundError: UnsupportedCapabilityError | undefined
  return createAcpDriver({ ...options, cwd, onEvent(event) {
    options.onEvent?.(backgroundError && event.type === 'turn/end' ? { ...event, unconfirmed: true } : event)
  } }, {
    id: 'codebuddy', label: 'CodeBuddy', resumeMethod: 'load', instructionMode: instructions ? 'native' : 'none',
    connect(callbacks) {
      if (backgroundError) throw backgroundError
      const executable = findExecutable(bin)
      if (!executable) throw new Error('CodeBuddy executable not found. Install CodeBuddy or edit the profile CLI path.')
      const stopBackground = () => {
        backgroundError = new UnsupportedCapabilityError(backgroundLimit)
        try { options.onEvent?.({ type: 'note', text: backgroundLimit }) } catch {}
        callbacks.onClose(backgroundError)
        peer.dispose()
      }
      const peer = jsonRpcProcess<AcpParams>({ bin: executable, args: ['--acp', ...(instructions ? ['--append-system-prompt', instructions] : [])], cwd, env, jsonrpc: '2.0', ...callbacks,
        onNotification(message) {
          if (nativeSessionId && message.method === 'session/update' && message.params?.sessionId === nativeSessionId) {
            const update = message.params.update
            if (typeof update?._meta?.['codebuddy.ai/memberEvent'] === 'string') return
            if (!message.params._meta?.isReplay && !update?._meta?.isReplay && (hasMultitask(update?.configOptions) || update?._meta?.['codebuddy.ai/unsolicitedTurn'])) return stopBackground()
          }
          callbacks.onNotification(message)
        },
        onRequest(message) {
          if (nativeSessionId && message.params?.sessionId === nativeSessionId && message.params?.toolCall?._meta?.['codebuddy.ai/isTeamMember'] === true) return stopBackground()
          callbacks.onRequest(message)
        },
      })
      return peer
    },
    initialize: peer => initializeAcp(peer, clientCapabilities),
    question: askQuestions,
    expandPrompt(text) {
      if (/^\s*\/multitask(?:\s|$)/i.test(text)) throw new UnsupportedCapabilityError(backgroundLimit)
      return text
    },
    async configure({ peer, sessionId, attached, permission }) {
      nativeSessionId = sessionId
      let configOptions = attached.configOptions
      if (hasMultitask(configOptions)) throw new UnsupportedCapabilityError(backgroundLimit)
      const current = (id: string) => (configOptions ?? []).find(item => item?.id === id)?.currentValue
      // The autonomy tiers mirror the claude channel this CLI derives from.
      const mode = permission === 'plan' ? 'plan' : permission === 'full' ? 'bypassPermissions' : 'auto'
      if (current('mode') !== mode) {
        const result = await peer.request<Pick<AcpAttached, 'configOptions'>>('session/set_config_option', { sessionId, configId: 'mode', value: mode })
        configOptions = result.configOptions ?? configOptions
      }
      if (model && current('model') !== model) {
        const result = await peer.request<Pick<AcpAttached, 'configOptions'>>('session/set_config_option', { sessionId, configId: 'model', value: model })
        configOptions = result.configOptions ?? configOptions
      }
      if (thinking && current('thought_level') !== thinking) await peer.request('session/set_config_option', { sessionId, configId: 'thought_level', value: thinking })
    },
  })
}
