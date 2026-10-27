import { h } from './ui-shared.js'

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
    const rows = items.map(item => h('option', { key: item.id, value: item.id, title: item.id }, item.label ?? item.id))
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
