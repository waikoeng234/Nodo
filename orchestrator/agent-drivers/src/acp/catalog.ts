import type { JsonRpcPeer } from '../json-rpc-process.js'

export type AcpConfigChoice = { value?: unknown; name?: unknown; group?: unknown; options?: unknown }
export type AcpConfigOption<Id = string> = { id?: Id; currentValue?: unknown; options?: unknown }
export type AcpThinkingLevels = { thinking?: { id: string; label?: string }[]; defaultThinking?: string }
export type AcpModel = AcpThinkingLevels & { id: string; label?: string; group?: string }
export type AcpModelCatalogOptions = { peer: JsonRpcPeer; sessionId: unknown; configOptions?: AcpConfigOption<unknown>[] | null; modelConfigId?: string; effortConfigId?: string }

// ACP engines advertise their model catalog as session config options, where the
// thinking-level option is rebuilt for whichever model is selected. A scan
// therefore selects every candidate in turn inside one throwaway session and
// reads the levels off each recomputed option set.
const choicesOf = (option?: AcpConfigOption<unknown>): AcpConfigChoice[] => (Array.isArray(option?.options) ? option.options as AcpConfigChoice[] : [])
  .flatMap(item => (Array.isArray(item?.options) ? item.options as AcpConfigChoice[] : [item]))

// The thinking levels of one model: `efforts` are {id, name} pairs and `preferred`
// the level the engine would pick on its own, which is only a default when the
// model actually lists it.
export const levelsOf = (efforts?: { id?: unknown; name?: unknown }[] | null, preferred?: unknown): AcpThinkingLevels => {
  const thinking = (efforts ?? []).flatMap((effort) => {
    const id = effort?.id === undefined || effort.id === null ? '' : String(effort.id)
    return id === '' ? [] : [{ id, ...(effort.name ? { label: String(effort.name) } : {}) }]
  })
  const wanted = preferred === undefined || preferred === null ? '' : String(preferred)
  return { ...(thinking.length ? { thinking } : {}), ...(thinking.some(level => level.id === wanted) ? { defaultThinking: wanted } : {}) }
}

const levelsFromOptions = (configOptions: AcpConfigOption<unknown>[] | null | undefined, effortConfigId?: string) => {
  const option = (configOptions ?? []).find(item => item.id === effortConfigId)
  // 'default' means the engine picks the level itself, which the host menu's
  // follow-the-agent entry already covers.
  return levelsOf(choicesOf(option).filter(level => typeof level?.value === 'string' && level.value !== '' && level.value !== 'default')
    .map(level => ({ id: level.value, name: level.name })), option?.currentValue)
}

// A choice outside a nested group may carry its provider in the value, the way
// OpenCode lists every model as `<provider>/<model>`: that provider is the
// section the model sits under, and a name repeating it drops the route prefix.
// A choice under a nested group already names its own section.
const sectionOf = (value: string, name: string, group: unknown) => {
  const at = value.indexOf('/')
  const provider = at > 0 ? value.slice(0, at) : ''
  const label = provider !== '' && name.startsWith(`${provider}/`) ? name.slice(provider.length + 1) : name
  const section = group ?? provider
  return { ...(label !== '' ? { label } : {}), ...(section ? { group: String(section) } : {}) }
}

// One model entry per choice of the model option; selecting a candidate makes
// the reply carry the complete recomputed option set, whose effort option names
// that model's levels. A candidate that cannot be selected keeps no levels.
export async function acpModelCatalog({ peer, sessionId, configOptions, modelConfigId = 'model', effortConfigId }: AcpModelCatalogOptions): Promise<AcpModel[]> {
  const modelOption = (configOptions ?? []).find(option => option.id === modelConfigId)
  const models: AcpModel[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(modelOption?.options) ? modelOption.options as AcpConfigChoice[] : []) {
    const group = Array.isArray(item?.options) ? item.name ?? item.group : undefined
    for (const choice of Array.isArray(item?.options) ? item.options as AcpConfigChoice[] : [item]) {
      if (typeof choice?.value !== 'string' || choice.value === '' || seen.has(choice.value)) continue
      seen.add(choice.value)
      let current = configOptions
      if (choice.value !== modelOption!.currentValue) {
        try { current = (await peer.request<{ configOptions?: AcpConfigOption<unknown>[] }>('session/set_config_option', { sessionId, configId: modelConfigId, value: choice.value })).configOptions }
        catch { current = undefined }
      }
      models.push({ id: choice.value, ...sectionOf(choice.value, String(choice.name ?? ''), group), ...(current ? levelsFromOptions(current, effortConfigId) : {}) })
    }
  }
  return models
}
