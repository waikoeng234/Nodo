// Which models this machine's DSH offers, and which thinking levels each one
// takes. Inside Desktop the host's own model directory answers in-process; a
// standalone dsh CLI answers over ACP, where `session/new` advertises the model
// list. The scan opens one ACP session and closes it again, so nothing is left
// behind.
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { acpModelCatalog, levelsOf } from '../acp/catalog.js'
import { connectDsh, findDshExecutable, initializeDsh, validateDshOptions } from './config.js'
import type { DshNativeHost } from './native-services.js'
import type { AcpAttached } from '../acp/core.js'
import type { ModelCatalog } from '../index.js'
import type { DshScanOptions } from './config.js'

type NativeLlm = Extract<ReturnType<NonNullable<DshNativeHost['get']>>, { listProviders?: unknown }>

const route = (provider: unknown, model: unknown) => JSON.stringify([provider, model])

// Every provider and model is looked up at once; the list keeps the host's order.
// A provider that cannot list is left out, and a model without metadata keeps
// only its name. The provider is the section a model sits under; the route id
// carries it for the value sent back.
async function hostModels(llm: NativeLlm) {
  const providers = (await llm.listProviders!()) ?? []
  const sections = await Promise.all(providers.map(async (provider) => {
    const listed = await Promise.resolve().then(() => llm.listModels(provider.id)).catch(() => [])
    const group = provider.name || provider.id
    return Promise.all((listed ?? []).map(async model => ({
      id: route(provider.id, model.id),
      label: String(model.name || model.id),
      ...(group ? { group: String(group) } : {}),
      ...await Promise.resolve().then(() => llm.resolveModelInfo(provider.id, model.id))
        .then(info => levelsOf(info?.reasoning?.efforts, info?.reasoning?.defaultEffort), () => ({})),
    })))
  }))
  return sections.flat()
}

async function acpModels({ engineOptions, cwd }: DshScanOptions) {
  const options = validateDshOptions(engineOptions)
  const executable = findDshExecutable(options.bin)
  if (!executable) return { source: 'DSH CLI not found', models: [] }
  const workdir = typeof cwd === 'string' && isAbsolute(cwd) ? cwd : homedir()
  const peer = connectDsh({ executable, cwd: workdir, options, onRequest: request => peer.refuse(request.id) })
  try {
    await initializeDsh(peer)
    const created = await peer.request<AcpAttached>('session/new', { cwd: workdir, mcpServers: [] })
    const models = await acpModelCatalog({ peer, sessionId: created.sessionId, configOptions: created.configOptions, effortConfigId: 'reasoning_effort' })
    await peer.request('session/close', { sessionId: created.sessionId }).catch(() => {})
    return { source: 'DSH ACP session config options', models }
  } finally { peer.dispose() }
}

export function scanDsh(options?: DshScanOptions): Promise<Omit<ModelCatalog, 'engine'>>
export function scanDsh(options: DshScanOptions): Promise<Omit<ModelCatalog, 'engine'>>
export async function scanDsh({ engineOptions = {}, nativeHost, cwd }: DshScanOptions = {}): Promise<Omit<ModelCatalog, 'engine'>> {
  const llm = nativeHost?.get?.('llm')
  if (llm !== undefined && typeof llm.listProviders === 'function') {
    const models = await hostModels(llm)
    if (models.length > 0) {
      const selection = nativeHost!.get?.('agentDefaultModel')?.currentSelection?.()
      const defaultModel = selection?.provider && selection?.model ? route(selection.provider, selection.model) : undefined
      return { source: 'DSH host model directory', ...(defaultModel ? { defaultModel } : {}), models }
    }
  }
  return acpModels({ engineOptions, cwd })
}
