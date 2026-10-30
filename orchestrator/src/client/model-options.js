import { h } from './ui-shared.js'

// A saved model is the route the engine is addressed by, not the name it is
// called: ZCode routes read `providerId$modelId`, Pi and OpenCode `provider/model`
// and the DSH pair a JSON array. Only the model's own name is shown.
export function modelName(raw) {
  let id = typeof raw === 'string' ? raw : ''
  if (id.startsWith('[')) {
    try {
      const [, model] = JSON.parse(id)
      if (typeof model === 'string' && model !== '') id = model
    } catch { /* not a JSON route pair; read it as a plain id */ }
  }
  const name = id.slice(Math.max(id.lastIndexOf('$'), id.lastIndexOf('/')) + 1)
  return name || id
}

// A catalog label with spaces is already a display name; a bare one is a route.
export const modelLabel = item => item.label && /\s/.test(item.label) ? item.label : modelName(item.label ?? item.id)

/** @typedef {{ id: string, label?: string }} ThinkingLevel */
/** @typedef {{ id: string, label?: string, group?: string, thinking?: ThinkingLevel[], defaultThinking?: string }} ModelChoice */

const unlistedOption = (value, choices) => value && !choices.some(item => item.id === value)
  ? [h('option', { key: value, value }, `不在清单：${value}`)] : []

/** @param {ModelChoice[]} models */
export function modelChoices(models, value = '', fallback = '') {
  const selected = models.find(item => item.id === (value || fallback))
  const providers = new Map()
  for (const item of models) providers.set(item.group ?? '', [...(providers.get(item.group ?? '') ?? []), item])
  const options = [...providers].flatMap(([group, items]) => {
    const rows = items.map(item => h('option', { key: item.id, value: item.id, title: item.id }, modelLabel(item)))
    return group === '' ? rows : [h('optgroup', { key: `group:${group}`, label: group }, ...rows)]
  })
  return { selected, value: selected?.id ?? value, levels: selected?.thinking ?? [], options: [...unlistedOption(value, models), ...options] }
}

/** @param {ModelChoice[]} models */
export const thinkingAfterModelChange = (models, model, thinking) =>
  (models.find(item => item.id === model)?.thinking ?? []).some(level => level.id === thinking) ? thinking : ''

/** @param {ModelChoice | undefined} model */
export const thinkingOptions = (model, value = '') => [
  ...unlistedOption(value, model?.thinking ?? []), ...(model?.thinking ?? []).map(level =>
    h('option', { key: level.id, value: level.id, title: level.id },
      level.id === model.defaultThinking ? `${level.label ?? level.id}（模型默认）` : level.label ?? level.id)),
]
